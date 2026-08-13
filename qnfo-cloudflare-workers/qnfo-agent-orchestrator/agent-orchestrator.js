/**
 * qnfo-agent-orchestrator — Cloudflare Worker
 * Remote agent execution for DeepChat thread offloading.
 * 
 * Phase 1 (2026-08-10): REST API + Durable Object per-task agent loop.
 *   POST /task  → create agent task, spawn DO
 *   GET  /task/:id → poll state + result
 *   GET  /health   → binding verification
 * 
 * Inference: Workers AI (@cf/qwen/qwen2.5-coder-32b-instruct)
 *   with native function calling. Free tier: 10k neurons/day.
 * 
 * Tools: search_papers (Vectorize), get_paper_context (D1), query_graph (D1).
 */

import { DurableObject } from "cloudflare:workers";

// ── System prompt ──────────────────────────────────────────────
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

When you are ready to answer, just respond with your final markdown output. Do not make additional tool calls.`;

// ── Tool definitions for function calling ──────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_papers",
      description: "Semantic search across the QWAV research paper corpus using vector embeddings. Returns paper slugs, scores, and metadata.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "integer", description: "Max results (1-10, default 5)", default: 5 }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_paper_context",
      description: "Get the full body text of a specific paper by its slug identifier.",
      parameters: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Paper slug (e.g., 'zbw-p5-capstone')" }
        },
        required: ["slug"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "query_graph",
      description: "Run a read-only SQL query against the QNFO knowledge graph (D1). Tables: nodes(id, name, label, properties JSON), edges(source_id, target_id, label, properties JSON).",
      parameters: {
        type: "object",
        properties: {
          sql: { type: "string", description: "SQL SELECT query (read-only)" }
        },
        required: ["sql"]
      }
    }
  }
];

// ── Durable Object: AgentTask ──────────────────────────────────
export class AgentTask extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const taskId = url.pathname.split("/").pop();

    // Start agent loop
    if (url.pathname.endsWith("/start") && request.method === "POST") {
      const { prompt, maxSteps = 5 } = await request.json();
      const state = {
        id: taskId,
        status: "running",
        prompt,
        maxSteps,
        step: 0,
        messages: [],
        result: null,
        error: null,
        createdAt: Date.now(),
        completedAt: null
      };
      await this.ctx.storage.put("state", state);
      // Watchdog: if the DO is evicted mid-loop, this alarm re-activates it and
      // marks a stale "running" task failed instead of leaving it hanging forever.
      await this.ctx.storage.setAlarm(Date.now() + 30 * 60 * 1000);
      this.ctx.waitUntil(this.runAgentLoop(taskId));
      return Response.json({ task_id: taskId, status: "running" });
    }

    // Watchdog alarm — fires if the loop never completed (DO eviction / crash)
    if (url.pathname.endsWith("/alarm") && request.method === "GET") {
      await this.alarm();
      return Response.json({ ok: true });
    }

    // Poll state
    if (url.pathname.endsWith("/status")) {
      const state = await this.ctx.storage.get("state");
      return Response.json(state || { error: "Task not found" });
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Watchdog: called by the runtime when the alarm fires ──
  // If the agent loop never completed (DO eviction / crash / hang), mark the
  // task failed so polling returns a terminal state instead of "running" forever.
  async alarm() {
    const state = await this.ctx.storage.get("state");
    if (state && state.status === "running") {
      state.status = "failed";
      state.error = "Task timed out: agent loop exceeded 30-minute watchdog";
      state.completedAt = Date.now();
      await this.ctx.storage.put("state", state);
      console.log(`[watchdog] task ${state.id} marked failed after 30min`);
    }
  }

  // ── Agent loop ───────────────────────────────────────────
  async runAgentLoop(taskId) {
    const state = await this.ctx.storage.get("state");
    if (!state) return;

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: state.prompt }
    ];

    try {
      for (let i = 0; i < state.maxSteps; i++) {
        state.step = i + 1;
        await this.ctx.storage.put("state", state);

        // Call Workers AI with function calling
        const aiResponse = await this.env.AI.run(
          "@cf/qwen/qwen2.5-coder-32b-instruct",
          {
            messages,
            tools: TOOLS,
            tool_choice: "auto",
            max_tokens: 4096,
            temperature: 0.3
          }
        );

        // Normalize tool calls to OpenAI format (Workers AI models may return non-standard shapes)
        const rawToolCalls = aiResponse.tool_calls || [];
        const toolCalls = rawToolCalls.map(tc => {
          // Extract function name and arguments from various possible shapes
          let fnName, fnArgs;
          if (tc.function) {
            fnName = tc.function.name;
            fnArgs = typeof tc.function.arguments === "string"
              ? tc.function.arguments
              : JSON.stringify(tc.function.arguments || {});
          } else if (tc.name) {
            // Llama 3.3 sometimes returns {name, arguments} without function wrapper
            fnName = tc.name;
            fnArgs = typeof tc.arguments === "string"
              ? tc.arguments
              : JSON.stringify(tc.arguments || {});
          } else {
            return null;
          }
          return {
            id: tc.id || `call_${crypto.randomUUID().slice(0, 8)}`,
            type: "function",
            function: { name: fnName, arguments: fnArgs }
          };
        }).filter(Boolean);

        if (toolCalls.length === 0) {
          // Agent is done — no more tool calls
          state.status = "completed";
          state.result = aiResponse.response || aiResponse.content || JSON.stringify(aiResponse);
          state.completedAt = Date.now();
          state.messages = messages;
          await this.ctx.storage.put("state", state);

          // Persist to R2
          await this.env.QNFO_PROJECTS.put(
            `_agent-results/${taskId}/result.json`,
            JSON.stringify(state, null, 2),
            { httpMetadata: { contentType: "application/json" } }
          );
          return;
        }

        // Execute tools
        messages.push({
          role: "assistant",
          content: aiResponse.response || "",
          tool_calls: toolCalls
        });

        for (const tc of toolCalls) {
          let result;
          try {
            const args = JSON.parse(tc.function.arguments);
            result = await this.executeTool(tc.function.name, args);
          } catch (e) {
            result = JSON.stringify({ error: `Tool execution failed: ${e.message}` });
          }
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: result
          });
        }
      }

      // Max steps reached — force final answer
      messages.push({
        role: "user",
        content: "You have reached the maximum number of steps. Provide your final answer now based on the information gathered. Do NOT make additional tool calls."
      });

      const finalResponse = await this.env.AI.run(
        "@cf/qwen/qwen2.5-coder-32b-instruct",
        { messages, max_tokens: 4096, temperature: 0.3 }
      );

      state.status = "completed";
      state.result = finalResponse.response || finalResponse.content || "No result produced";
      state.completedAt = Date.now();
      state.messages = messages;
      await this.ctx.storage.put("state", state);

      await this.env.QNFO_PROJECTS.put(
        `_agent-results/${taskId}/result.json`,
        JSON.stringify(state, null, 2),
        { httpMetadata: { contentType: "application/json" } }
      );

    } catch (err) {
      state.status = "failed";
      state.error = err.message;
      state.completedAt = Date.now();
      await this.ctx.storage.put("state", state);
    }
  }

  // ── Tool execution ───────────────────────────────────────
  async executeTool(name, args) {
    switch (name) {
      case "search_papers": {
        const limit = Math.min(args.limit || 5, 10);
        // Embed query using bge-base-en-v1.5 (matching the qwav-research-v2 index)
        const embedResp = await this.env.AI.run("@cf/baai/bge-base-en-v1.5", {
          text: [args.query]
        });
        const vector = embedResp.data?.[0] || embedResp[0];
        if (!vector) return JSON.stringify({ error: "Embedding failed" });
        // Query Vectorize with the embedded vector
        const results = await this.env.PAPER_VZ.query(vector, {
          topK: limit,
          returnValues: false,
          returnMetadata: true
        });
        const matches = results.matches.map(m => ({
          id: m.id,
          score: Math.round(m.score * 1000) / 1000,
          slug: m.metadata?.slug || m.id,
          title: m.metadata?.title || "",
          authors: m.metadata?.authors || ""
        }));
        return JSON.stringify({ count: matches.length, matches });
      }

      case "get_paper_context": {
        const row = await this.env.LIVING_PAPER
          .prepare("SELECT body_md, doi, authors, title FROM papers WHERE slug = ?")
          .bind(args.slug)
          .first();
        if (!row) return JSON.stringify({ error: `Paper not found: ${args.slug}` });
        return JSON.stringify({
          slug: args.slug,
          doi: row.doi,
          title: row.title,
          authors: row.authors,
          body: (row.body_md || "").substring(0, 8000)
        });
      }

      case "query_graph": {
        const sql = (args.sql || "").trim();
        if (!sql.toUpperCase().startsWith("SELECT")) {
          return JSON.stringify({ error: "Only SELECT queries allowed" });
        }
        const result = await this.env.QNFO_GRAPH.prepare(sql).all();
        return JSON.stringify({
          results: result.results,
          count: result.results?.length || 0
        });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  }
}

// ── Main Worker: HTTP API ─────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // ── Auth gate (AI-ENDPOINT-AUTH-1): mutating endpoints require X-Sync-Token ──
    // GET endpoints (/health, /task/:id polling, /) stay open.
    if (method === "POST" || method === "PATCH") {
      const auth = request.headers.get("X-Sync-Token");
      if (!auth || !env.SYNC_TOKEN || auth !== env.SYNC_TOKEN) {
        return Response.json({ error: "Unauthorized: missing or invalid X-Sync-Token" }, { status: 401 });
      }
    }

    // ── /health ──
    if (url.pathname === "/health") {
      return Response.json({
        worker: "qnfo-agent-orchestrator",
        version: "v1.0.0",
        status: "ok",
        bindings: {
          d1_living_paper: !!env.LIVING_PAPER,
          d1_graph: !!env.QNFO_GRAPH,
          vectorize: !!env.PAPER_VZ,
          r2: !!env.QNFO_PROJECTS,
          ai: !!env.AI,
          do_agent_task: !!env.AGENT_TASK
        },
        uptime: Date.now()
      });
    }

    // ── POST /task ──
    if (url.pathname === "/task" && request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: "Invalid JSON body" }, { status: 400 });
      }

      if (!body.prompt || typeof body.prompt !== "string") {
        return Response.json({ error: "Missing required field: prompt (string)" }, { status: 400 });
      }

      const taskId = crypto.randomUUID();
      const maxSteps = Math.min(body.max_steps || 5, 10);

      const doId = env.AGENT_TASK.idFromName(taskId);
      const stub = env.AGENT_TASK.get(doId);

      ctx.waitUntil(
        stub.fetch(new Request(`https://do/task/${taskId}/start`, {
          method: "POST",
          body: JSON.stringify({ prompt: body.prompt, maxSteps })
        }))
      );

      return Response.json({
        task_id: taskId,
        status: "queued",
        poll_url: `/task/${taskId}`
      }, { status: 202 });
    }

    // ── GET /task/:id ──
    const taskMatch = url.pathname.match(/^\/task\/([a-f0-9-]+)$/);
    if (taskMatch && request.method === "GET") {
      const taskId = taskMatch[1];
      const doId = env.AGENT_TASK.idFromName(taskId);
      const stub = env.AGENT_TASK.get(doId);
      const resp = await stub.fetch(new Request(`https://do/task/${taskId}/status`));
      return resp;
    }

    // ── GET / ──
    if (url.pathname === "/") {
      return Response.json({
        worker: "qnfo-agent-orchestrator",
        endpoints: {
          "POST /task": "Create agent task { prompt, max_steps? }",
          "GET /task/:id": "Poll task status and result",
          "GET /health": "Worker health and binding check"
        }
      });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }
};
