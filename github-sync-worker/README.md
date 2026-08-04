# github-sync Worker

Daily export of GitHub Issues to Cloudflare R2 audit trail.

## Architecture

```
Cron (06:00 UTC daily)
    → scheduled() handler
    → GitHub REST API (per repo)
    → R2: audit/github/{date}/{repo}-issues.json
    → R2: audit/github/latest/{repo}-issues.json  (overwritten)
    → R2: audit/github/{date}/_sync-report.json
```

## Bindings

| Binding | Type | Purpose |
|:--------|:-----|:--------|
| `QNFO` | R2 Bucket | Storage for all audit exports |
| `GITHUB_TOKEN` | Secret | GitHub PAT with `issues:read` scope |

## Tracked Repos

- `rwnq8/prompts` — System prompts factory
- `qnfo/QWAV` — QWAV program
- `rwnq8/quantum-laws-of-form` — QLoF paper
- `rwnq8/ultrametricity` — Ultrametricity paper
- `rwnq8/prompts-wiki` — Wiki backup

## Manual Trigger

```bash
curl https://github-sync.<worker-subdomain>.workers.dev
```

## Deployment

```bash
cd G:\My Drive\projects\github-sync-worker
wrangler secret put GITHUB_TOKEN
wrangler deploy
```
