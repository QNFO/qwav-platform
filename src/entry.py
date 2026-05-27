"""github-sync v1.1 — Daily GitHub Issues export to Cloudflare R2

Cron: Daily at 06:00 UTC
Bindings: QNFO (R2 bucket), GITHUB_TOKEN (secret)
"""
from js import Response, JSON, fetch, console, Object
import json as _json
from datetime import datetime, timezone


REPOS = [
    "rwnq8/prompts",
]
PER_PAGE = 100
GH_API = "https://api.github.com"


async def gh_get(token, repo):
    """Fetch all issues for a repo from GitHub API."""
    all_data = []
    page = 1
    while True:
        url = f"{GH_API}/repos/{repo}/issues?state=all&per_page={PER_PAGE}&page={page}"
        console.log(f"  GET {url}")

        try:
            resp = await fetch(url, Object.fromEntries([
                ["headers", Object.fromEntries([
                    ["Authorization", f"Bearer {token}"],
                    ["Accept", "application/vnd.github+json"],
                    ["User-Agent", "github-sync-worker/1.1"],
                    ["X-GitHub-Api-Version", "2022-11-28"],
                ])]
            ]))
        except Exception as e:
            console.error(f"  fetch() threw: {str(e)}")
            break

        status = resp.status
        console.log(f"  HTTP {status}")

        if status == 404:
            console.warn(f"  Repo not found: {repo}")
            return None
        if status == 401:
            console.error(f"  Auth failed — check GITHUB_TOKEN secret")
            return None
        if status != 200:
            body = await resp.text()
            console.error(f"  Unexpected status {status}: {body[:200]}")
            break

        body = await resp.text()
        console.log(f"  Response body length: {len(body)} chars")

        try:
            data = _json.loads(body)
        except Exception as e:
            console.error(f"  JSON parse failed: {str(e)}")
            console.error(f"  Raw body: {body[:500]}")
            break

        if not isinstance(data, list):
            console.error(f"  Expected list, got {type(data).__name__}: {str(data)[:200]}")
            break

        if not data:
            console.log(f"  Empty page — done")
            break

        all_data.extend(data)
        console.log(f"  Page {page}: {len(data)} issues (total: {len(all_data)})")

        if len(data) < PER_PAGE:
            break
        page += 1

    return all_data


async def scheduled(event, env, ctx):
    """Cron: export GitHub Issues to R2."""
    token = env.GITHUB_TOKEN
    bucket = env.QNFO
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")
    iso = now.isoformat()

    console.log(f"[github-sync] Sync start: {iso}")
    console.log(f"[github-sync] Token starts with: {token[:10]}...")
    results = {}

    for repo in REPOS:
        console.log(f"[github-sync] === {repo} ===")
        try:
            issues = await gh_get(token, repo)
        except Exception as e:
            console.error(f"[github-sync] {repo}: EXCEPTION — {str(e)}")
            results[repo] = {"status": "error", "error": str(e)}
            continue

        if issues is None:
            results[repo] = {"status": "not_found", "count": 0}
            console.log(f"[github-sync] {repo}: not_found")
            continue

        count = len(issues)
        console.log(f"[github-sync] {repo}: {count} issues fetched")

        payload = _json.dumps({
            "repo": repo,
            "exported_at": iso,
            "issue_count": count,
            "issues": issues,
        })

        # Dated snapshot
        dated_key = f"audit/github/{date_str}/{repo.replace('/', '-')}-issues.json"
        console.log(f"[github-sync] Writing to R2: {dated_key}")
        try:
            await bucket.put(dated_key, payload)
            console.log(f"[github-sync]   dated snapshot OK")
        except Exception as e:
            console.error(f"[github-sync]   dated snapshot FAILED: {str(e)}")

        # Latest snapshot
        latest_key = f"audit/github/latest/{repo.replace('/', '-')}-issues.json"
        console.log(f"[github-sync] Writing to R2: {latest_key}")
        try:
            await bucket.put(latest_key, payload)
            console.log(f"[github-sync]   latest snapshot OK")
        except Exception as e:
            console.error(f"[github-sync]   latest snapshot FAILED: {str(e)}")

        results[repo] = {"status": "ok", "count": count}

    report = _json.dumps({
        "timestamp": iso,
        "worker": "github-sync",
        "results": results,
    })
    report_key = f"audit/github/{date_str}/_sync-report.json"
    await bucket.put(report_key, report)
    console.log(f"[github-sync] Report written: {report_key}")

    return results


async def on_fetch(request, env):
    """HTTP trigger for manual sync."""
    results = await scheduled(None, env, None)
    return Response.new(_json.dumps(results), Object.fromEntries([
        ["headers", Object.fromEntries([
            ["Content-Type", "application/json"]
        ])]
    ]))
