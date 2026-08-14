// qnfo-agent-ws — QNFO AI Agent
// Cloudflare Agents SDK AIChatAgent (WebSocket-native) + OpenAI-compatible HTTP
// surface for plug-and-play use with OpenClaw.
//
// Endpoints:
//   GET  /health                      — health + binding check
//   GET  /                           — endpoint index
//   GET  /v1/models                  — model list (OpenAI-compatible)
//   POST /v1/chat/completions        — chat completions (OpenAI-compatible, SSE)
//   WS   /agents/qnfo-agent/{name}   — native Agents SDK WebSocket chat
//
// Auth: mutating endpoints require X-Sync-Token or Authorization: Bearer <token>.

import { AIChatAgent } from "@cloudflare/ai-chat";
import { routeAgentRequest, getAgentByName, routeAgentEmail, callable } from "agents";
import { convertToModelMessages } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { z } from "zod";

const VERSION = "1.3.9";
const MAX_BODY = 64 * 1024;
const CLOUDFLARE_API_MCP_URL = "https://mcp.cloudflare.com/mcp";

const SYSTEM_PROMPT = `You are a QNFO research agent running on Cloudflare Workers. You have access to tools that query the QNFO knowledge infrastructure (D1 papers database, Vectorize semantic search, graph database).

RULES:
1. Use the available tools to gather information before answering.
2. When you have enough information, provide a clear, concise final answer.
3. Cite specific papers by slug when referencing them.
4. If a tool returns no results, try a different query or report what you found.
5. Output your final answer as plain markdown — no tool calls in the final response.

TOOLS AVAILABLE:
- search_papers(query, limit?): Semantic search across the QWAV research corpus. Returns paper slugs, scores, and metadata.
- get_paper_context(slug): Get the full body text of a specific paper.
- query_graph(sql): Run a read-only SQL query against the QNFO knowledge graph D1 database. Tables: nodes (id, name, label, properties), edges (source_id, target_id, label, properties).

CLOUDFLARE ACCOUNT AUTOMATION (MCP tools, via cloudflare-api server):
- docs(): Search the Cloudflare documentation. Use for any question about Cloudflare products or features (Workers, Pages, R2, D1, Durable Objects, KV, Vectorize, AI Gateway, etc.).
- search(): Search the Cloudflare OpenAPI spec (2,500+ endpoints across DNS, Workers, R2, Zero Trust, D1, Vectorize, and every other product) for a capability. Returns the endpoint reference and required parameters. Use BEFORE execute() when you need to find the right API call.
- execute(): Run generated JavaScript against the Cloudflare API client to perform the operation (read or write) in an isolated Dynamic Worker sandbox. The code has access to a typed client and the Cloudflare API spec.

IMPORTANT — Code Mode contract for search()/execute() (MANDATORY):
- The code parameter MUST be a complete JavaScript async arrow function expression.
- NEVER pass natural language, a sentence, or a bare keyword. That is ALWAYS invalid.
- The sandbox pre-sets these variables: cloudflare (with .request()), spec (the OpenAPI spec object), and accountId (string).

MANDATORY PATTERN — the ONLY accepted format for code:
  async () => { const results = []; for (const [path, methods] of Object.entries(spec.paths)) { for (const [method, op] of Object.entries(methods)) { if (path.includes('YOUR_KEYWORD') && method === 'get') { results.push({ method: method.toUpperCase(), path, summary: op?.summary }); } } } return results; }

EXAMPLE for search (find Workers list endpoint) — send EXACTLY this shape:
  async () => { const results = []; for (const [path, methods] of Object.entries(spec.paths)) { for (const [method, op] of Object.entries(methods)) { if (path.includes('workers/scripts') && method === 'get') { results.push({ method: method.toUpperCase(), path, summary: op?.summary }); } } } return results; }

EXAMPLE for execute (list Workers) — send EXACTLY this shape:
  async () => { const resp = await cloudflare.request({ method: 'GET', path: '/accounts/' + accountId + '/workers/scripts' }); return resp; }

RULE: Your FIRST Cloudflare API tool call MUST be search() with a valid async arrow function as described. After search returns endpoints, call execute() with an async arrow function that uses cloudflare.request(). If a tool returns an error, fix the JavaScript, never repeat the same invalid code.

RULES FOR CLOUDFLARE API OPERATIONS:
1. Read-only (GET) operations are always safe — use them freely to inspect resources.
2. Before ANY write/mutation (POST/PUT/PATCH/DELETE): state exactly what you will change and ask the user for confirmation first.
3. After a mutation, verify the result by reading back the resource.
4. Never expose API tokens or credentials in your output.

When you are ready to answer, just respond with your final markdown output. Do not make additional tool calls.`;

// ── Model selection ──────────────────────────────────────────────────────
// NOTE: tool calling uses the RAW Workers AI binding (env.AI.run with
// tools/tool_choice) — llama-3.3-70b emits structured tool_calls through the
// raw binding (proven in qnfo-agent-orchestrator), but workers-ai-provider +
// streamText serializes tool calls as plain text, which breaks the loop.

const AGENT_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

function getModel(env) {
  if (env.DEEPSEEK_API_KEY) {
    const openai = createOpenAI({
      apiKey: env.DEEPSEEK_API_KEY,
      baseURL: "https://api.deepseek.com",
    });
    return openai("deepseek-chat");
  }
  return null; // raw binding path used for Workers AI
}

const QNFO_ROUTER_URL = "https://qnfo-ai.q08.workers.dev/v1/chat/completions";

// Route inference through the qnfo-ai router when ROUTER_AUTH_KEY is present
// AND no tools are needed. CRITICAL: tool-calling turns MUST use the raw
// Workers AI binding — the qnfo-ai router does NOT forward `tools` to its
// upstream providers (verified in qnfo-ai source: callDeepSeek/runWorkersAI
// omit the tools array), so routing a tool turn through it silently drops the
// Cloudflare API MCP declarations and the loop stalls. The raw binding with a
// code-capable model (qwen2.5-coder-32b) drives the Code Mode search/execute
// pattern correctly.
async function callModel(env, msgs, tools, maxTokens) {
  const hasTools = tools && tools.length;
  // v1.3.3: route tool turns through qnfo-ai -> DeepSeek (Code Mode capable; qnfo-ai
  // v4.3.10 now forwards `tools`). Workers AI raw binding remains the no-key fallback.
  if (env.ROUTER_AUTH_KEY) {
    // Service binding bypasses the workers.dev->workers.dev recursion block (Cloudflare 1042).
    // v1.3.5: binding fetches must NOT use the target's workers.dev hostname (edge reroute ->
    // 1042). Use an internal host; qnfo-ai routes by path only.
    const useBinding = !!env.QNFO_AI;
    const doFetch = useBinding ? (u, init) => env.QNFO_AI.fetch(u, init) : fetch;
    const routerUrl = useBinding
      ? "https://qnfo-ai.internal/v1/chat/completions"
      : QNFO_ROUTER_URL;
    const resp = await doFetch(routerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + env.ROUTER_AUTH_KEY,
      },
      body: JSON.stringify({
        model: hasTools ? "deepseek-v4-flash" : "auto",
        messages: msgs,
        max_tokens: maxTokens || 4096,
        stream: false,
        ...(hasTools ? { tools, tool_choice: "auto" } : {}),
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error("router " + resp.status + ": " + errText.slice(0, 300));
    }
    const out = await resp.json();
    if (out?.choices?.[0]?.message) {
      const m = out.choices[0].message;
      return {
        response: typeof m.content === "string" ? m.content : "",
        content: typeof m.content === "string" ? m.content : "",
        tool_calls: m.tool_calls || [],
        _router: out._router || null,
      };
    }
    return out;
  }
  return env.AI.run(AGENT_MODEL, {
    messages: msgs,
    tools: tools || undefined,
    tool_choice: hasTools ? "auto" : undefined,
    max_tokens: maxTokens || 4096,
    temperature: 0.3,
  });
}


// ── Raw agent loop (proven structured tool calling) ──────────────────────

function flattenContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof p.text === "string" ? p.text : ""))
      .join("");
  }
  return "";
}

function toLegacyMessages(messages) {
  return (messages || [])
    .filter((m) => m && typeof m.role === "string")
    .map((m) => ({ role: m.role, content: flattenContent(m.content) }));
}

function normalizeToolCalls(toolCalls) {
  const out = [];
  for (const tc of toolCalls || []) {
    let fnName, fnArgs;
    if (tc.function) {
      fnName = tc.function.name;
      fnArgs = typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments || {});
    } else if (tc.name) {
      fnName = tc.name;
      fnArgs = typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments || {});
    } else {
      continue;
    }
    out.push({
      id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
      type: "function",
      function: { name: fnName, arguments: fnArgs },
    });
  }
  return out;
}

// OpenAI-format tool declarations for the raw binding (QNFO tools)
function buildOpenAITools() {
  return [
    {
      type: "function",
      function: {
        name: "search_papers",
        description: "Semantic search across the QWAV research paper corpus using vector embeddings. Returns paper slugs, scores, and metadata.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Natural language search query" },
            limit: { type: "integer", description: "Max results (1-10, default 5)", default: 5 },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "get_paper_context",
        description: "Get the full body text of a specific paper by its slug identifier.",
        parameters: {
          type: "object",
          properties: { slug: { type: "string", description: "Paper slug (e.g., 'zbw-p5-capstone')" } },
          required: ["slug"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "query_graph",
        description: "Run a read-only SQL query against the QNFO knowledge graph (D1). Tables: nodes(id, name, label, properties JSON), edges(source_id, target_id, label, properties JSON).",
        parameters: {
          type: "object",
          properties: { sql: { type: "string", description: "SQL SELECT query (read-only)" } },
          required: ["sql"],
        },
      },
    },
  ];
}

// MCP tools (e.g., Cloudflare API) as OpenAI-format declarations
function buildMcpOpenAITools(mcpTools) {
  const out = [];
  for (const t of mcpTools || []) {
    out.push({
      type: "function",
      function: {
        name: `cf_${t.name}`,
        description: `[Cloudflare API MCP] ${t.description || ""}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    });
  }
  return out;
}

// Execute a QNFO tool
async function executeQnfoTool(env, name, args) {
  switch (name) {
    case "search_papers": {
      const limit = Math.min(args.limit || 5, 10);
      const embedResp = await env.AI.run("@cf/baai/bge-base-en-v1.5", { text: [args.query] });
      const vector = embedResp.data?.[0] || embedResp[0];
      if (!vector) return JSON.stringify({ error: "Embedding failed" });
      const results = await env.PAPER_VZ.query(vector, { topK: limit, returnValues: false, returnMetadata: true });
      const matches = results.matches.map((m) => ({
        id: m.id,
        score: Math.round(m.score * 1000) / 1000,
        slug: m.metadata?.slug || m.id,
        title: m.metadata?.title || "",
        authors: m.metadata?.authors || "",
      }));
      return JSON.stringify({ count: matches.length, matches });
    }
    case "get_paper_context": {
      const row = await env.LIVING_PAPER.prepare("SELECT body_md, doi, authors, title FROM papers WHERE slug = ?").bind(args.slug).first();
      if (!row) return JSON.stringify({ error: `Paper not found: ${args.slug}` });
      return JSON.stringify({ slug: args.slug, doi: row.doi, title: row.title, authors: row.authors, body: (row.body_md || "").substring(0, 8000) });
    }
    case "query_graph": {
      const sql = (args.sql || "").trim();
      if (!sql.toUpperCase().startsWith("SELECT")) return JSON.stringify({ error: "Only SELECT queries allowed" });
      const result = await env.QNFO_GRAPH.prepare(sql).all();
      return JSON.stringify({ results: result.results, count: result.results?.length || 0 });
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

// The core ReAct loop. Returns { text, steps }.
async function runAgentTurn(env, messages, { abortSignal, onFinish, mcp } = {}) {
  const legacy = toLegacyMessages(messages);
  const msgs = [
    { role: "system", content: SYSTEM_PROMPT },
    ...legacy,
  ];
  const tools = buildOpenAITools();
  let mcpTools = [];
  if (mcp?.listTools) {
    try {
      mcpTools = mcp.listTools() || [];
      tools.push(...buildMcpOpenAITools(mcpTools));
    } catch (e) {
      console.error("[mcp] listTools failed:", e?.message || e);
    }
  }
  let steps = 0;
  let finalText = "";
  for (; steps < 8; steps++) {
    const aiResp = await callModel(env, msgs, tools, 4096);
    const toolCalls = normalizeToolCalls(aiResp.tool_calls || []);
    console.log("[loop] step=" + steps + " model=" + (aiResp?._router?.routed_model || aiResp?._router?.model || "?") + " toolCalls=" + JSON.stringify(toolCalls.map(t => t.function.name + ":" + t.function.arguments.slice(0, 120))));
    if (!toolCalls.length) {
      finalText = aiResp.response || aiResp.content || JSON.stringify(aiResp);
      break;
    }
    msgs.push({ role: "assistant", content: aiResp.response || "", tool_calls: toolCalls });
    for (const tc of toolCalls) {
      let result;
      try {
        const args = JSON.parse(tc.function.arguments || "{}");
        if (tc.function.name.startsWith("cf_") && mcp?.callTool) {
          const mcpRes = await mcp.callTool({ arguments: args, name: tc.function.name.slice(3), serverId: "cloudflare-api" });
          result = JSON.stringify(mcpRes);
          console.log("[loop] mcp result " + tc.function.name + " -> " + result.slice(0, 300));
        } else {
          result = await executeQnfoTool(env, tc.function.name, args);
        }
      } catch (e) {
        result = JSON.stringify({ error: `Tool execution failed: ${e.message}` });
      }
      msgs.push({ role: "tool", tool_call_id: tc.id, content: result });
    }
  }
  if (!finalText && steps >= 8) {
    msgs.push({ role: "user", content: "You have reached the maximum number of steps. Provide your final answer now based on the information gathered. Do NOT make additional tool calls." });
    const finalResponse = await callModel(env, msgs, null, 4096);
    finalText = finalResponse.response || finalResponse.content || "No result produced";
  }
  return { text: finalText, steps };
}

// ── Auth helpers ─────────────────────────────────────────────────────────

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const av = enc.encode(a);
  const bv = enc.encode(b);
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function isAuthorized(request, env) {
  const expected = env.SYNC_TOKEN;
  if (!expected) return false;
  const header =
    request.headers.get("X-Sync-Token") ||
    request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ||
    "";
  return timingSafeEqualStr(header, expected);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    },
  });
}

// ── OpenAI-compatible HTTP adapter ───────────────────────────────────────

function toOpenAIMessages(body) {
  // Accept OpenAI chat messages or a bare string prompt.
  if (Array.isArray(body)) return body;
  if (Array.isArray(body.messages)) return body.messages;
  if (typeof body.input === "string") {
    return [{ role: "user", content: body.input }];
  }
  if (Array.isArray(body.input)) return body.input;
  return [];
}

async function handleChatCompletions(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON" }, 400);
  }
  const messages = toOpenAIMessages(body);
  if (!messages.length) return json({ error: "messages required" }, 400);
  const model = typeof body.model === "string" ? body.model : "qnfo-agent";
  const wantStream = body.stream === true;
  const id = "chatcmpl-" + Math.random().toString(16).slice(2, 10);
  const created = Math.floor(Date.now() / 1000);

  try {
    const result = await runAgentTurn(env, messages, {});
    const chunks = [result.text];

    if (wantStream) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          try {
            for (const delta of chunks) {
              const payload = {
                id,
                object: "chat.completion.chunk",
                created,
                model,
                choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
              };
              controller.enqueue(encoder.encode("data: " + JSON.stringify(payload) + "\n\n"));
            }
            const done = {
              id,
              object: "chat.completion.chunk",
              created,
              model,
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            };
            controller.enqueue(encoder.encode("data: " + JSON.stringify(done) + "\n\n"));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-cache",
        },
      });
    }

    let content = chunks.join("");
    return json({
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

function handleModels(env) {
  const data = [
    {
      id: "qnfo-agent",
      object: "model",
      created: 1710000000,
      owned_by: "qnfo",
      _agent: {
        version: VERSION,
        model: env.DEEPSEEK_API_KEY
          ? "deepseek-chat"
          : "workers-ai llama-3.3-70b (structured tool calls)",
        tools: [
          "search_papers",
          "get_paper_context",
          "query_graph",
          ...(env.CF_API_TOKEN ? ["cloudflare_api (search/execute — 2,500+ endpoints)"] : []),
        ],
        transport: ["websocket", "http-sse"],
      },
    },
  ];
  return json({ object: "list", data });
}

// ── AIChatAgent (WebSocket-native) ───────────────────────────────────────

export class QnfoAgent extends AIChatAgent {
  // Autonomous daily report — runs inside THIS agent instance (no extra DO class).
  // Offloads a DeepChat cronjob to Cloudflare: gather stats, AI-summarize, persist.
  // scheduleEvery takes SECONDS; 24h = 86400 (not ms — the ms value exceeds the
  // 30-day cap and silently fails). The callback is the method name directly.
  async onStart() {
    try {
      await this.scheduleEvery(24 * 60 * 60, "runDailyReport", {});
      console.log("[schedule] daily-qnfo-report registered");
    } catch (err) {
      console.log("[schedule] failed: " + String(err).slice(0, 120));
    }
  }
  // Cloudflare-native email (v1.3.0): inbound via routeAgentEmail -> onEmail;
  // outbound via sendEmail(). Uses the EMAIL send_email binding.
  async onEmail(email) {
    try {
      const raw = await email.getRaw();
      const from = email.from;
      const subject = email.subject || '';
      const text = typeof raw === 'string' ? raw.slice(0, 8000) : '[binary]';
      console.log("[email] from=" + from + " subject=" + subject.slice(0, 80));
      // Persist inbound to D1 chat_logs-style table (best-effort)
      await this.env.LIVING_PAPER.prepare(
        "INSERT INTO email_logs (ts, from_addr, subject, body) VALUES (?, ?, ?, ?)"
      ).bind(new Date().toISOString(), String(from), subject.slice(0, 200), text.slice(0, 4000)).run().catch(() => {});
    } catch (err) {
      console.log("[email] onEmail error: " + String(err).slice(0, 160));
    }
  }

  // Public DO method — RPC-callable via stub without decorator (plain JS; @callable() is invalid syntax)
  async sendEmail({ to, subject, text, html }) {
    try {
      await this.env.EMAIL.send({
        to: to || '',
        from: "agent@qnfo.org",
        subject: subject || "QNFO Agent message",
        text: text || "",
        html: html || "",
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err).slice(0, 200) };
    }
  }

  async runDailyReport() {
    const report = {};
    try {
      const r = await this.env.LIVING_PAPER.prepare(
        "SELECT COUNT(*) AS total, COUNT(DISTINCT slug) AS distinct_slugs, " +
        "SUM(CASE WHEN body_md IS NOT NULL THEN 1 ELSE 0 END) AS with_body FROM papers"
      ).first();
      report.papers = r || {};
      const n = await this.env.QNFO_GRAPH.prepare("SELECT COUNT(*) AS n FROM nodes").first();
      const e = await this.env.QNFO_GRAPH.prepare("SELECT COUNT(*) AS e FROM edges").first();
      report.graph = { nodes: n?.n ?? 0, edges: e?.e ?? 0 };
      let summary = "no summary";
      try {
        const aiResp = await this.env.AI.run("@cf/qwen/qwen3-30b-a3b-fp8", {
          messages: [{ role: "user", content:
            "Produce a 2-3 sentence daily QNFO infrastructure summary. Data: " +
            JSON.stringify(report) + ". Be factual and concise." }],
          max_tokens: 300,
        });
        summary = aiResp?.response || aiResp?.result?.response || JSON.stringify(aiResp).slice(0, 400);
      } catch (err) {
        summary = "AI summary unavailable: " + String(err).slice(0, 120);
      }
      report.summary = summary;
      console.log("[report] " + new Date().toISOString() + " " + JSON.stringify(report).slice(0, 500));
      return report;
    } catch (err) {
      console.log("[report] error: " + String(err).slice(0, 200));
      return { error: String(err).slice(0, 200) };
    }
  }

  // Lazily connect the Cloudflare API MCP server once per agent instance.
  // Uses the account API token as a bearer token (no OAuth redirect needed).
  async ensureCloudflareMcp() {
    if (this._cfMcpReady !== undefined) return this._cfMcpReady;
    this._cfMcpReady = false;
    if (!this.env.CF_API_TOKEN) {
      console.log("[mcp] CF_API_TOKEN not set — skipping cloudflare-api MCP server");
      return false;
    }
    try {
      const result = await this.addMcpServer("cloudflare-api", CLOUDFLARE_API_MCP_URL, {
        transport: {
          headers: { Authorization: `Bearer ${this.env.CF_API_TOKEN}` },
        },
      });
      this._cfMcpState = result?.state || "connecting";
      this._cfMcpReady = this._cfMcpState !== "failed";
      console.log(`[mcp] cloudflare-api state: ${this._cfMcpState}`);
    } catch (e) {
      console.error("[mcp] addMcpServer failed:", e?.message || e);
      this._cfMcpError = e?.message || String(e);
    }
    return this._cfMcpReady;
  }

  async onChatMessage(onFinish, options) {
    await this.ensureCloudflareMcp();
    let mcpTools = {};
    if (this._cfMcpReady) {
      try {
        // Wait for connection + tool discovery to settle before reading tools —
        // getAITools() returns an EMPTY set while the connection is still
        // connecting/discovering (this caused silent tool absence + no_progress loops).
        await this.mcp.waitForConnections({ timeout: 20000 });
        mcpTools = this.mcp.getAITools() || {};
        this._cfMcpToolCount = Object.keys(mcpTools).length;
        console.log(`[mcp] cloudflare-api tools loaded: ${this._cfMcpToolCount}`);
      } catch (e) {
        console.error("[mcp] getAITools failed:", e?.message || e);
        this._cfMcpError = e?.message || String(e);
      }
    }
    let result;
    try {
      result = await runAgentTurn(
        this.env,
        await convertToModelMessages(this.messages),
        { abortSignal: options?.abortSignal, onFinish, mcp: this.mcp }
      );
    } catch (e) {
      return new Response("AGENT ERROR: " + (e?.message || String(e)), {
        headers: { "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    // AIChatAgent._reply handles a plain text body via _sendPlaintextReply
    // (text-start / text-delta / text-end). createUIMessageStreamResponse
    // requires a ReadableStream, not an async generator, in ai v7.
    return new Response(result.text || "No response generated.", {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  // Debug RPC: report MCP connection state from inside the DO so we can
  // distinguish "connection failed" from "tools skipped on schema conversion".
  async onRequest(request) {
    const url = new URL(request.url);
    if (url.pathname.includes("/mcp-status")) {
      // Trigger the lazy connection so this probe reflects a REAL connect attempt
      await this.ensureCloudflareMcp();
      let serverState = null;
      let toolCount = 0;
      let toolNames = [];
      let mcpError = this._cfMcpError || null;
      try {
        if (this.mcp?.waitForConnections) await this.mcp.waitForConnections({ timeout: 20000 });
        const aiTools = this.mcp?.getAITools ? this.mcp.getAITools() : {};
        toolCount = Object.keys(aiTools || {}).length;
        toolNames = Object.keys(aiTools || {});
        const servers = this.mcp?.state?.servers || this.mcp?.servers || null;
        serverState = servers ? Object.fromEntries(
          Object.entries(servers).map(([id, s]) => [id, { state: s?.state, error: s?.error || null, tools: (s?.tools || []).length }])
        ) : null;
      } catch (e) {
        mcpError = (mcpError ? mcpError + " | " : "") + "status: " + (e?.message || e);
      }
      return Response.json({
        cfMcpReady: !!this._cfMcpReady,
        cfMcpState: this._cfMcpState || null,
        cfMcpError: mcpError,
        cfMcpToolCount: this._cfMcpToolCount ?? toolCount,
        toolNames,
        serverState,
        env: {
          cf_token: !!this.env?.CF_API_TOKEN,
          sync_token: !!this.env?.SYNC_TOKEN,
          deepseek: !!this.env?.DEEPSEEK_API_KEY,
        },
      });
    }
    return super.onRequest?.(request) ?? new Response("Not found", { status: 404 });
  }
}


// ── Worker fetch handler ─────────────────────────────────────────────────

export default {
  async email(message, env, ctx) {
    await routeAgentEmail(message, env, {
      resolver: async (email, env) => {
        return { agent: "QnfoAgent", instance: email.to?.includes("agent@") ? "agent" : "default" };
      },
      onNoRoute: (email) => {
        console.warn("No route for email from " + (email?.from || "?"));
        email?.setReject?.("Unknown recipient");
      },
    });
  },
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": "*",
        },
      });
    }

    // ── Auth gate: mutating endpoints require shared secret ──
    const requiresAuth = method === "POST" || path.startsWith("/agents/");
    if (requiresAuth && !isAuthorized(request, env)) {
      return json({ error: "Unauthorized: missing or invalid X-Sync-Token" }, 401);
    }

    // Native Agents SDK routing (WebSocket chat at /agents/qnfo-agent/{name})
    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) return agentResponse;

    // Debug: report MCP connection state from a live DO instance
    if (path === "/debug/agent" && method === "GET") {
      try {
        const agent = await getAgentByName(env.QnfoAgent, "debug-probe");
        const resp = await agent.fetch(new Request("https://internal/mcp-status"));
        return new Response(resp.body, {
          status: resp.status,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        });
      } catch (e) {
        return json({ error: e?.message || String(e) }, 500);
      }
    }

    // OpenAI-compatible surface
    if (path === "/v1/reports/run" && method === "POST") {
      try {
        const agent = await getAgentByName(env.QnfoAgent, "reporter");
        const result = await agent.runDailyReport();
        return json({ ok: true, agent: "QnfoAgent", instance: "reporter", result });
      } catch (e) {
        return json({ ok: false, error: e?.message || String(e) }, 500);
      }
    }

    if (path === "/health" && method === "GET") {
      return json({
        status: "ok",
        worker: "qnfo-agent-ws",
        version: VERSION,
        bindings: {
          d1_living_paper: !!env.LIVING_PAPER,
          d1_graph: !!env.QNFO_GRAPH,
          vectorize: !!env.PAPER_VZ,
          ai: !!env.AI,
          deepseek_key: !!env.DEEPSEEK_API_KEY,
          auth: !!env.SYNC_TOKEN,
          mcp_cloudflare_api: !!env.CF_API_TOKEN,
          email: !!env.EMAIL,
        },
      });
    }
    // Debug: direct MCP probe from the Workers runtime (tests token + URL
    // exactly as the SDK MCP client would, without the agent/DO layer).
    if (path === "/debug/router" && method === "GET") {
      try {
        const doFetch = env.QNFO_AI ? (u, init) => env.QNFO_AI.fetch(u, init) : fetch;
        const r = await doFetch("https://qnfo-ai-any-host/v1/models", {
          headers: { Authorization: "Bearer " + (env.ROUTER_AUTH_KEY || "") },
        });
        const t = await r.text();
        return json({ binding: !!env.QNFO_AI, hasKey: !!env.ROUTER_AUTH_KEY, status: r.status, body: t.slice(0, 300) });
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }
    if (path === "/debug/mcp" && method === "GET") {
      try {
        const initResp = await fetch(CLOUDFLARE_API_MCP_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
            Authorization: `Bearer ${env.CF_API_TOKEN}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "qnfo-agent-ws-debug", version: VERSION },
            },
          }),
        });
        const text = await initResp.text();
        return json({
          status: initResp.status,
          body: text.slice(0, 3000),
        });
      } catch (e) {
        return json({ error: e?.message || String(e) }, 500);
      }
    }
    if (path === "/" && method === "GET") {
      return json({
        worker: "qnfo-agent-ws",
        version: VERSION,
        endpoints: {
          "GET /health": "Health and binding check",
          "GET /debug/mcp": "Direct MCP probe (auth/token test)",
          "GET /v1/models": "OpenAI-compatible model list",
          "POST /v1/chat/completions": "OpenAI-compatible chat (stream=true for SSE)",
          "WS /agents/qnfo-agent/:name": "Native Agents SDK WebSocket chat",
        },
      });
    }
    if (path === "/v1/models" && method === "GET") return handleModels(env);
    if (path === "/v1/chat/completions" && method === "POST")
      return handleChatCompletions(request, env);

    return json({ error: "Not found", path }, 404);
  },
};
