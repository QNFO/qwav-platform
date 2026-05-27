# QNFO/QWAV Decision Log

> Unified decision record for all QNFO and QWAV projects.
> Maintained by: github-sync Worker + agent session closeouts.
> Last updated: 2026-05-27

---

## 2026-05-27 — Cloudflare Audit Trail Implementation

### Decision: Cloudflare is the distribution + survivability layer, not the development platform

**Status:** Accepted
**Context:** After completing Phase 1 Cloudflare migration (14 domains, 4 Pages sites, DNS, bulk redirects, $0/month), user requested migration of "everything" to Cloudflare. Full capability assessment performed.

**Rationale:**
- Cloudflare Workers cannot run git, provide a filesystem, or execute subprocesses
- Agent runtime requires local filesystem + git + Python with full stdlib
- Cloudflare Pages, R2, Vectorize, and Workers are ideal for: static hosting, DNS, object storage, semantic search, cron jobs, email processing
- GitHub remains the primary development platform (git, Issues, Projects, Wiki)
- Google Drive remains the working directory for agent runtime

**Architecture:**
- Cloudflare = Distribution layer (Pages, DNS, R2 archive, Workers, Vectorize)
- GitHub = Development layer (git, Issues, Projects, Wiki, Discussions)
- Local = Agent runtime (DeepChat, DeepSeek API, Python, git, PowerShell)

### Decision: Build unified audit trail on Cloudflare R2 + Vectorize

**Status:** Implemented (Phase 1)
**Context:** Need LLM-accessible documentation of every chat, project, decision, sprint, issue, backlog, and roadmap.

**Implementation:**
- R2 bucket (qnfo) with audit/ directory structure: conversations/, github/, decisions/, infrastructure/, wiki/
- github-sync Worker: daily cron (06:00 UTC) exports GitHub Issues to R2
- First export: rwnq8/prompts (33 issues, 151 KB)
- ask-qwav Worker: existing AI + Vectorize bindings, ready for semantic search
- Vectorize index (qwav-research): 768d cosine, ready for population

### Decision: Use gh auth token for Worker secrets

**Status:** Implemented
**Rationale:** Token has full scopes (repo, project, workflow, write:discussion). Set as Cloudflare secret via `wrangler secret put GITHUB_TOKEN`. Workers access via env.GITHUB_TOKEN.

### Decision: Python Workers require Object.fromEntries() for fetch options

**Status:** Discovered (2026-05-27)
**Context:** Initial worker code used Python dicts for fetch headers. This worked for the HTTP 200 response but R2 writes failed silently.
**Fix:** Use Object.fromEntries() to create JS objects from Python tuples for all fetch options and Response headers.

### Decision: wrangler r2 object commands default to local mode

**Status:** Discovered (2026-05-27)
**Context:** `wrangler r2 object get` without --remote returns "The specified key does not exist" even when files are present.
**Fix:** Always use --remote flag for R2 object get/delete operations. Put operations work in local mode but get/delete need --remote.

---

## 2026-05-27 — Phase 1 Cloudflare Migration (Earlier Session)

### Decision: qnfo.org is the platform root

**Status:** Accepted, partially implemented
**Source:** CLOUDFLARE-CLOSEOUT-2026-05-27.md
**Context:** QNFO is the organization, QWAV is a computing program within it.

### Decision: No new domains — 14 existing sufficient

**Status:** Decided, no domains purchased
**Source:** CLOUDFLARE-CLOSEOUT-2026-05-27.md

### Decision: PM Strategy — Hybrid GitHub (live) + Cloudflare (mirror)

**Status:** Strategy decided, mirror partially built
**Source:** CLOUDFLARE-CLOSEOUT-2026-05-27.md

### Decision: rwnq8 repos stay on GitHub (for now)

**Status:** Accepted
**Source:** CLOUDFLARE-CLOSEOUT-2026-05-27.md

---

*Decision log format: ISO 8601 dates, status tracking, rationale, source traceability.*
