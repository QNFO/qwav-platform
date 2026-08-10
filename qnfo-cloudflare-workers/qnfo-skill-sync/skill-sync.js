/**
 * qnfo-skill-sync — Cloudflare Worker
 * Always-on kaizen/sync engine for the QNFO skills ecosystem.
 *
 * Functions:
 *   1. Ingest local DeepChat session logs (POST /log/chat)
 *   2. Ingest user-specified issues/optimizations (POST /issues)
 *   3. Daily cron: AI-extract issues from chat logs → D1 agent_issues
 *   4. Daily cron: generate kaizen report → GitHub commit + R2 snapshot
 *   5. GET /issues → prioritized backlog for local execution
 *
 * Canonical flow:
 *   GitHub QNFO/qnfo-skills = source of truth (git)
 *   Worker pushes kaizen-reports/ + mirrors repo tree to R2 qnfo-skills
 *   Local scheduled task: git pull → copy to .deepchat/skills
 */

// ── Helpers ─────────────────────────────────────────────────────

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}

// UTF-8-safe base64 for GitHub Contents API (btoa only handles Latin1)
function base64Encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

async function readJson(req) {
  try { return await req.json(); } catch { return null; }
}

async function githubFetch(env, path, init = {}) {
  const headers = {
    "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
    "Accept": "application/vnd.github+json",
    "User-Agent": "qnfo-skill-sync",
    ...(init.headers || {})
  };
  return fetch(`https://api.github.com${path}`, { ...init, headers });
}

// ── Issue extraction prompt ─────────────────────────────────────
const EXTRACT_PROMPT = `You are the QNFO kaizen issue extractor. Analyze the following DeepChat session summaries and extract actionable issues, errors, or optimization opportunities. 

Rules:
- Only extract real, actionable items. Ignore routine session chatter.
- For each item, output JSON with: title (short), description (1-2 sentences), category (error | optimization | request | infrastructure), priority (high | medium | low).
- Prioritize: errors → high; resource/infrastructure problems → high; user requests → medium; minor optimizations → low.
- Output ONLY a JSON array. No markdown, no commentary.

SESSION SUMMARIES:
{summaries}

OUTPUT:`;

// ── Main Worker ─────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    // ── /health ──
    if (url.pathname === "/health") {
      return json({
        worker: "qnfo-skill-sync",
        version: "v1.0.0",
        status: "ok",
        bindings: { d1: !!env.AUDIT_DB, r2: !!env.SKILLS_BUCKET, ai: !!env.AI, github_token: !!env.GITHUB_TOKEN },
        cron: "0 3 * * *"
      });
    }

    // ── POST /log/chat — ingest local session log ──
    if (url.pathname === "/log/chat" && method === "POST") {
      const body = await readJson(request);
      if (!body || !body.session_id) return json({ error: "session_id required" }, 400);

      const createdAt = body.created_at || Date.now();
      const res = await env.AUDIT_DB.prepare(
        "INSERT INTO chat_logs (session_id, source, provider_id, model_id, title, message_count, summary, error_flag, created_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(
        body.session_id.slice(0, 200),
        body.source || "deepchat",
        body.provider_id || null,
        body.model_id || null,
        (body.title || "").slice(0, 500),
        body.message_count || 0,
        (body.summary || "").slice(0, 8000),
        body.error_flag ? 1 : 0,
        createdAt
      ).run();

      return json({ success: true, id: res.meta.last_row_id });
    }

    // ── POST /issues — user-specified optimization/request ──
    if (url.pathname === "/issues" && method === "POST") {
      const body = await readJson(request);
      if (!body || !body.title) return json({ error: "title required" }, 400);
      const now = Date.now();

      const res = await env.AUDIT_DB.prepare(
        "INSERT INTO agent_issues (title, description, source, category, priority, status, linked_session, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
      ).bind(
        body.title.slice(0, 500),
        (body.description || "").slice(0, 4000),
        body.source || "user",
        body.category || "optimization",
        body.priority || "medium",
        "open",
        body.linked_session || null,
        now, now
      ).run();

      return json({ success: true, id: res.meta.last_row_id });
    }

    // ── GET /issues — prioritized backlog ──
    if (url.pathname === "/issues" && method === "GET") {
      const status = url.searchParams.get("status") || "open";
      const category = url.searchParams.get("category");
      const priority = url.searchParams.get("priority");
      const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);

      let sql = "SELECT * FROM agent_issues WHERE status = ?";
      const params = [status];
      if (category) { sql += " AND category = ?"; params.push(category); }
      if (priority) { sql += " AND priority = ?"; params.push(priority); }
      sql += " ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, created_at DESC LIMIT ?";
      params.push(limit);

      const res = await env.AUDIT_DB.prepare(sql).bind(...params).all();
      return json({ count: res.results.length, issues: res.results });
    }

    // ── PATCH /issues/:id — update status ──
    const issueMatch = url.pathname.match(/^\/issues\/(\d+)$/);
    if (issueMatch && method === "PATCH") {
      const body = await readJson(request);
      const id = issueMatch[1];
      const status = body?.status;
      if (!["open", "in_progress", "done", "wontfix", "blocked"].includes(status)) {
        return json({ error: "invalid status" }, 400);
      }
      await env.AUDIT_DB.prepare(
        "UPDATE agent_issues SET status = ?, updated_at = ? WHERE id = ?"
      ).bind(status, Date.now(), id).run();
      return json({ success: true, id: Number(id), status });
    }

    // ── POST /kaizen/run — manual kaizen cycle trigger ──
    if (url.pathname === "/kaizen/run" && method === "POST") {
      const sync = url.searchParams.get("sync") === "true";
      if (sync) {
        const report = await runKaizenCycle(env);
        return json(report);
      }
      ctx.waitUntil(runKaizenCycle(env));
      return json({ success: true, message: "kaizen cycle started (async)" });
    }

    // ── GET /skills/status — GitHub vs R2 sync status ──
    if (url.pathname === "/skills/status") {
      // Get latest GitHub commit SHA
      const gh = await githubFetch(env, `/repos/${env.SKILLS_REPO}/commits/${env.SKILLS_BRANCH}`);
      const ghJson = gh.ok ? await gh.json() : null;
      const ghSha = ghJson?.sha || null;
      const ghErr = gh.ok ? null : await gh.text();

      // Get R2 snapshot
      const snap = await env.SKILLS_BUCKET.get("_sync/last-snapshot.json");
      const snapData = snap ? JSON.parse(await snap.text()) : null;

      return json({
        repo: env.SKILLS_REPO,
        branch: env.SKILLS_BRANCH,
        github_head: ghSha,
        github_error: ghErr ? ghErr.slice(0, 300) : null,
        r2_snapshot_sha: snapData?.sha || null,
        r2_snapshot_at: snapData?.at || null,
        in_sync: ghSha !== null && ghSha === snapData?.sha
      });
    }

    return json({ error: "Not found" }, 404);
  },

  // ── Daily cron: 03:00 UTC ─────────────────────────────────────
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runKaizenCycle(env));
  }
};

// ── Kaizen cycle ────────────────────────────────────────────────

async function runKaizenCycle(env) {
  const started = Date.now();
  const report = { date: new Date().toISOString().slice(0, 10), extracted: 0, issues: 0, reportUrl: null, errors: [] };

  try {
    // 1. Pull unprocessed chat logs
    const logs = await env.AUDIT_DB.prepare(
      "SELECT id, session_id, title, summary, error_flag FROM chat_logs WHERE processed = 0 ORDER BY id DESC LIMIT 100"
    ).all();

    // 2. AI-extract issues from logs — process in small batches to respect model context
    if (logs.results.length > 0) {
      const BATCH = 6; // ~6 sessions × ~600 chars summary ≈ safe for 24k-token context
      for (let bi = 0; bi < logs.results.length; bi += BATCH) {
        const batch = logs.results.slice(bi, bi + BATCH);
        const summaries = batch.map(l => {
          const flag = l.error_flag ? " [ERROR]" : "";
          return `- Session ${l.session_id}: ${l.title || "untitled"}${flag}\n  ${(l.summary || "").slice(0, 400)}`;
        }).join("\n");

        const aiResp = await env.AI.run(
          "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
          { messages: [{ role: "user", content: EXTRACT_PROMPT.replace("{summaries}", summaries) }], max_tokens: 1024, temperature: 0.2 }
        );
        // Robust response extraction — Workers AI returns an OpenAI-style completion:
        //   aiResp.response (array of tool results) OR aiResp.choices[0].message.content (JSON string)
        let items = [];
        if (Array.isArray(aiResp?.response)) {
          items = aiResp.response;
        } else {
          let text = "";
          if (typeof aiResp === "string") text = aiResp;
          else if (typeof aiResp?.choices?.[0]?.message?.content === "string") text = aiResp.choices[0].message.content;
          else if (typeof aiResp?.response === "string") text = aiResp.response;
          else if (typeof aiResp?.content === "string") text = aiResp.content;
          else text = JSON.stringify(aiResp);

          // Parse JSON from text — balanced-bracket scan for the FIRST complete block
          const cleaned = text.replace(/```(?:json)?\s*/g, "").replace(/```/g, "").trim();
          const firstJsonBlock = (s) => {
            const open = s.indexOf("{");
            const openArr = s.indexOf("[");
            let start;
            if (openArr >= 0 && (open < 0 || openArr < open)) { start = openArr; }
            else if (open >= 0) { start = open; }
            else return null;
            let depth = 0, inStr = false, esc = false;
            for (let i = start; i < s.length; i++) {
              const c = s[i];
              if (inStr) {
                if (esc) esc = false;
                else if (c === "\\") esc = true;
                else if (c === '"') inStr = false;
                continue;
              }
              if (c === '"') inStr = true;
              else if (c === "{" || c === "[") depth++;
              else if (c === "}" || c === "]") {
                depth--;
                if (depth === 0) return s.slice(start, i + 1);
              }
            }
            return null;
          };
          const block = firstJsonBlock(cleaned);
          if (block) {
            try {
              const parsed = JSON.parse(block);
              if (!Array.isArray(parsed) && typeof parsed === "object") {
                for (const k of ["issues", "items", "results", "findings"]) {
                  if (Array.isArray(parsed[k])) { items = parsed[k]; break; }
                }
                if (items.length === 0 && Object.values(parsed).some(v => v && typeof v === "object" && !Array.isArray(v))) {
                  items = Object.values(parsed).filter(v => v && typeof v === "object" && !Array.isArray(v));
                }
              } else {
                items = Array.isArray(parsed) ? parsed : [parsed];
              }
            } catch (e) { report.errors.push(`AI parse: ${e.message}`); }
          } else {
            report.errors.push("AI parse: no complete JSON block found in response");
          }
          // Debug: keep raw AI for diagnostics on first batch failure
          if (items.length === 0 && bi === 0) report.rawAI = text.slice(0, 1500);
        }

        // Insert extracted issues
        const now = Date.now();
        for (const item of items.slice(0, 20)) {
          if (!item.title) continue;
          const priority = ["high", "medium", "low"].includes(item.priority) ? item.priority : "medium";
          const category = ["error", "optimization", "request", "infrastructure"].includes(item.category) ? item.category : "optimization";
          await env.AUDIT_DB.prepare(
            "INSERT INTO agent_issues (title, description, source, category, priority, status, linked_session, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
          ).bind(
            item.title.slice(0, 500),
            (item.description || "").slice(0, 4000),
            "kaizen-ai",
            category, priority, "open", null, now, now
          ).run();
          report.extracted++;
        }
      }

      // Mark logs processed
      for (const l of logs.results) {
        await env.AUDIT_DB.prepare("UPDATE chat_logs SET processed = 1 WHERE id = ?").bind(l.id).run();
      }
    }

    // 3. Count open issues for report
    const open = await env.AUDIT_DB.prepare(
      "SELECT priority, COUNT(*) as n FROM agent_issues WHERE status = 'open' GROUP BY priority"
    ).all();
    report.issues = open.results.reduce((a, r) => a + r.n, 0);
    report.byPriority = Object.fromEntries(open.results.map(r => [r.priority, r.n]));

    // 4. Generate + store kaizen report
    const body = [
      `# Kaizen Report — ${report.date}`,
      "",
      `- Generated: ${new Date().toISOString()}`,
      `- Chat logs scanned: ${logs.results.length}`,
      `- Issues extracted: ${report.extracted}`,
      `- Open issues total: ${report.issues}`,
      `- By priority: ${JSON.stringify(report.byPriority || {})}`,
      report.errors.length ? `- Errors: ${report.errors.join("; ")}` : "- Errors: none",
      "",
      "## Next actions",
      "1. Pull prioritized issues: `GET /issues?status=open&priority=high`",
      "2. Execute local: `python .deepchat/scripts/pull_skills.py`",
      ""
    ].join("\n");

    // Compatible with the kaizen skill's existing kaizen_reports schema:
    // (id TEXT PRIMARY KEY, session_id, report_date, findings, improvements_applied, created_at, _version, wbs_code)
    const repId = `sync-${report.date}`;
    await env.AUDIT_DB.prepare(
      `INSERT INTO kaizen_reports (id, session_id, report_date, findings, improvements_applied, _version, wbs_code)
       VALUES (?,?,?,?,?,1,'SYN-E0')
       ON CONFLICT(id) DO UPDATE SET report_date=excluded.report_date, findings=excluded.findings, improvements_applied=excluded.improvements_applied`
    ).bind(repId, "cron-sync", report.date, body, JSON.stringify(report)).run();

    // 5. Push report to GitHub (commit via API)
    try {
      const path = `kaizen-reports/${report.date}.md`;
      const b64 = base64Encode(body);

      // Check if file exists (need SHA for update)
      let sha = null;
      const existing = await githubFetch(env, `/repos/${env.SKILLS_REPO}/contents/${path}`, { headers: { "ref": env.SKILLS_BRANCH } });
      if (existing.ok) {
        const ex = await existing.json();
        sha = ex.sha;
      }

      const putResp = await githubFetch(env, `/repos/${env.SKILLS_REPO}/contents/${path}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: `kaizen: daily report ${report.date} [bot]`,
          content: b64,
          branch: env.SKILLS_BRANCH,
          ...(sha ? { sha } : {})
        })
      });
      if (putResp.ok) {
        const pr = await putResp.json();
        report.reportUrl = pr.content?.html_url || pr.content?.git_url || null;
      } else {
        const errText = await putResp.text();
        report.errors.push(`GitHub push: ${putResp.status} ${errText.slice(0, 200)}`);
      }
    } catch (e) {
      report.errors.push(`GitHub push: ${e.message}`);
    }

    // 6. Snapshot GitHub HEAD to R2 (sync status baseline)
    try {
      const gh = await githubFetch(env, `/repos/${env.SKILLS_REPO}/commits/${env.SKILLS_BRANCH}`);
      if (gh.ok) {
        const head = await gh.json();
        await env.SKILLS_BUCKET.put("_sync/last-snapshot.json", JSON.stringify({
          sha: head.sha,
          at: new Date().toISOString(),
          report: report.date
        }), { httpMetadata: { contentType: "application/json" } });
      }
    } catch (e) {
      report.errors.push(`R2 snapshot: ${e.message}`);
    }

  } catch (e) {
    report.errors.push(`Cycle: ${e.message}`);
  }

  report.durationMs = Date.now() - started;
  return report;
}
