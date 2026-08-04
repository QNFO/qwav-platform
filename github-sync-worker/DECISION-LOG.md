# QNFO/QWAV Decision Log

> Unified decision record for all QNFO and QWAV projects.
> Maintained by: github-sync Worker + agent session closeouts.
> Last updated: 2026-05-27 (Session: Cloudflare Audit Trail Implementation)

---

## 2026-05-27 — Cloudflare Audit Trail Implementation (Session 2)

### Decision: Build complete reusable automation layer for Cloudflare operations

**Status:** Implemented
**Context:** After building the R2 audit trail infrastructure and cron worker, the user requested reusable instructions/code/scripting that DeepChat agents can execute autonomously — "invisible to end user, always there."

**Implementation:**
- cloudflare-deployer skill v2.0: Complete rewrite (3,116 → 16,054 bytes). Covers Workers (cron + HTTP), R2, Vectorize, secrets, DNS via REST API, bulk redirects. 10 failure modes documented. Python Worker quirks (Object.fromEntries, --remote flag, compatibility_flags).
- closeout-manager skill v2.0: Added mandatory R2 audit trail export + decision log update.
- REBUILD-FROM-SCRATCH.md (11,885 bytes): Idiot-proof crash recovery. Covers installation, authentication, cloning, deploying all workers, recreating R2 structure, verification.
- CLOUDFLARE-AUDIT-EXPORT template: Structured session export format for R2.
- DEFAULT.md §10: Closeout now references CLOUDFLARE-AUDIT-EXPORT template, cloudflare-deployer v2.0 skill, closeout-manager v2.0 skill, and REBUILD-FROM-SCRATCH.md.

### Decision: System reload required for new templates to activate

**Status:** Discovered (F11)
**Context:** CLOUDFLARE-AUDIT-EXPORT is correctly registered in prompts.json (29 entries, verified on disk) but `list_all_prompt_template_names()` does not include it. The runtime system caches the pre-rebuild template list.
**Impact:** Agents cannot use `fill_prompt_template("CLOUDFLARE-AUDIT-EXPORT")` until DeepChat restarts. Manual wrangler commands from DEFAULT.md §10 are the fallback.
**Mitigation:** Documented in REBUILD-FROM-SCRATCH.md (added after discovery).

### Decision: wrangler Unicode output crashes Python subprocess on Windows (F12)

**Status:** Discovered (2026-05-27)
**Context:** wrangler terminal output contains Unicode box-drawing characters (U+2500-U+257F) that cause UnicodeEncodeError when captured via Python subprocess with cp1252 encoding.
**Fix:** Use `encoding='utf-8', errors='replace'` or `text=False` + manual decode. Documented in cloudflare-deployer skill failure catalog.

### Decision: GitHub API returns HTTP 200 with empty array for flagged/blocked orgs (F13)

**Status:** Discovered (2026-05-27)
**Context:** qnfo/QWAV returns HTTP 200 with `[]` instead of an error when the QNFO org is flagged. Worker reports `count=0` which is indistinguishable from a repo with zero issues.
**Mitigation:** Documented as GitHub quirk. Worker handles gracefully.

---

## 2026-05-27 — Cloudflare Audit Trail Infrastructure (Session 1)

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
