# QNFO Audit Trail

This R2 bucket contains the complete audit trail for all QNFO/QWAV projects.

## Directory Structure

```
audit/
├── README.md                    ← This file
├── conversations/               ← Agent session exports
│   └── YYYY-MM-DD-topic.md
├── github/                      ← GitHub Issues/Projects exports
│   ├── YYYY-MM-DD/              ← Dated snapshots
│   │   ├── rwnq8-prompts-issues.json
│   │   ├── qnfo-QWAV-issues.json
│   │   └── _sync-report.json
│   └── latest/                  ← Latest snapshot (overwritten daily)
│       ├── rwnq8-prompts-issues.json
│       └── qnfo-QWAV-issues.json
├── decisions/                   ← Unified decision log
│   └── DECISION-LOG.md
├── infrastructure/              ← Cloudflare state snapshots
│   └── YYYY-MM-DD-snapshot.md
├── wiki/                        ← GitHub Wiki mirror
│   └── ...
└── repos/                       ← Git repo archives (15 QNFO repos)
    └── ...
```

## Access

- **Public browse:** https://archive.qnfo.org
- **Semantic search:** https://ask-qwav.q08.workers.dev
- **Direct R2:** `wrangler r2 object get qnfo/audit/...`

## Automation

- **github-sync Worker:** Daily export of GitHub Issues → `audit/github/` (cron: 06:00 UTC)
- **Session closeout:** Agents export conversations → `audit/conversations/` after each session

---
*Managed autonomously via DeepChat agents. Last updated: 2026-05-27.*
