"""r2-test — Minimal R2 write test"""
from js import Response, Object, fetch


async def on_fetch(request, env):
    bucket = env.QNFO
    results = []

    # Test 1: Simple put
    try:
        await bucket.put("audit/_r2-test.txt", "R2 binding works! 2026-05-27")
        results.append("PUT OK: audit/_r2-test.txt")
    except Exception as e:
        results.append(f"PUT FAILED: {str(e)}")

    # Test 2: JSON put
    try:
        await bucket.put("audit/_r2-test.json", '{"test": true, "timestamp": "2026-05-27T19:00:00Z"}')
        results.append("PUT OK: audit/_r2-test.json")
    except Exception as e:
        results.append(f"PUT FAILED: {str(e)}")

    # Test 3: Check if we can list (might not work from Worker)
    try:
        # R2 list isn't directly available in Workers; try get
        obj = await bucket.get("audit/README.md")
        if obj:
            body = await obj.text()
            results.append(f"GET OK: audit/README.md ({len(body)} chars)")
        else:
            results.append("GET: audit/README.md is null")
    except Exception as e:
        results.append(f"GET FAILED: {str(e)}")

    return Response.new("\n".join(results))
