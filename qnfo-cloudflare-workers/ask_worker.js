// ask-qwav Worker — AI-powered research Q&A across QNFO paper corpus
// Cloudflare Workers | 2026-07-10

const HTML = (content) => `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>Ask QWAV — AI Research Assistant</title><meta name="description" content="AI-powered Q&A over QNFO's research corpus on ultrametric quantum computing, p-adic physics, and quantum foundations."><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet"><style>:root{--blue:#1a56db;--blue-dark:#1040a8;--blue-light:#dbeafe;--blue-subtle:#eff6ff;--text:#1a1a2e;--text-muted:#6b7280;--bg:#fff;--border:#e5e7eb;--radius:8px;--max-w:960px}*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Source Serif 4',Georgia,serif;color:var(--text);background:var(--bg);line-height:1.7}h1,h2,h3,nav{font-family:'Inter',system-ui,sans-serif}nav{position:sticky;top:0;background:rgba(255,255,255,.95);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:.75rem 0;z-index:100}nav .inner{max-width:var(--max-w);margin:0 auto;padding:0 1.5rem;display:flex;gap:1.5rem;align-items:center}nav a{color:var(--blue);text-decoration:none;font-weight:500;font-size:.9rem}nav a:hover{color:var(--blue-dark)}main{max-width:var(--max-w);margin:0 auto;padding:3rem 1.5rem}.hero{text-align:center;margin-bottom:2rem}.hero h1{font-size:2rem;font-weight:700}.hero p{color:var(--text-muted);font-size:1.1rem;max-width:600px;margin:.5rem auto 1.5rem}.search-box{background:var(--blue-subtle);border:1px solid var(--border);border-radius:var(--radius);padding:2rem;max-width:600px;margin:0 auto}.search-box input{width:100%;padding:.75rem 1rem;border:1px solid var(--border);border-radius:var(--radius);font-size:1rem;font-family:'Inter',sans-serif;margin-bottom:.75rem}.search-box button{background:var(--blue);color:#fff;border:none;padding:.75rem 2rem;border-radius:var(--radius);font-size:1rem;font-weight:500;cursor:pointer}.search-box button:hover{background:var(--blue-dark)}.results{margin-top:2rem;max-width:800px;margin-left:auto;margin-right:auto}.result-card{background:#f9fafb;border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem;margin-bottom:.75rem;transition:box-shadow .15s}.result-card:hover{box-shadow:0 4px 12px rgba(0,0,0,.08)}.result-card h3{font-size:1.1rem}.result-card h3 a{color:var(--blue);text-decoration:none}.result-card p{color:var(--text-muted);font-size:.9rem;margin-top:.25rem}.badge{display:inline-block;padding:.15em .5em;border-radius:3px;font-size:.75rem;margin-right:.5rem}.badge-doi{background:var(--blue-light);color:var(--blue)}footer{margin-top:3rem;padding:1.5rem;border-top:1px solid var(--border);text-align:center;font-family:'Inter',sans-serif;font-size:.85rem;color:var(--text-muted)}footer a{color:var(--blue)}</style></head><body><nav><div class="inner"><a href="https://qnfo.org"><strong>QNFO</strong></a><a href="https://papers.qnfo.org/">Papers</a><a href="https://deep.qwav.tech/">QWAV Deep</a><a href="https://legal.qnfo.org/">Legal</a></div></nav><main>${content}</main><footer><p>QNFO Research Hub — <a href="https://qnfo.org">qnfo.org</a></p></footer></body></html>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const q = url.searchParams.get('q') || '';

    if (!q) {
      return new Response(HTML(`
        <div class="hero">
          <h1>Ask QWAV AI</h1>
          <p>AI-powered research assistant — query the QNFO corpus on ultrametric quantum computing, p-adic physics, and quantum foundations.</p>
        </div>
        <div class="search-box">
          <input type="text" id="query" placeholder="Ask a research question..." onkeypress="if(event.key==='Enter')search()">
          <button onclick="search()">Ask QWAV AI</button>
        </div>
        <script>function search(){var q=document.getElementById('query').value.trim();if(q)window.location.href='?q='+encodeURIComponent(q)}</script>
      `), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // Search papers in D1
    try {
      const stmt = env.DB.prepare(
        'SELECT slug, title, doi, abstract FROM papers WHERE slug IS NOT NULL AND slug != ? ORDER BY created_at DESC LIMIT 100'
      ).bind('None');
      const { results } = await stmt.all();

      // Simple relevance scoring: match query terms against title + abstract
      const terms = q.toLowerCase().split(/\s+/).filter(t => t.length > 2);
      const scored = results.map(p => {
        const title = (p.title || '').toLowerCase();
        const abstract = (p.abstract || '').toLowerCase();
        let score = 0;
        for (const t of terms) {
          if (title.includes(t)) score += 10;
          if (abstract.includes(t)) score += 3;
        }
        return { ...p, score };
      }).filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 20);

      const resultsHtml = scored.length === 0
        ? '<p style="text-align:center;color:var(--text-muted)">No matching papers found. Try different keywords.</p>'
        : scored.map(p => `
          <div class="result-card">
            <h3><a href="https://papers.qnfo.org/papers/${p.slug}/">${escapeHtml(p.title || 'Untitled')}</a></h3>
            <p>${escapeHtml((p.abstract || '').slice(0, 200))}...</p>
            <p style="font-size:.8rem;margin-top:.5rem">${p.doi ? `<span class="badge badge-doi">DOI: ${escapeHtml(p.doi)}</span>` : ''}Score: ${p.score}</p>
          </div>
        `).join('\n');

      return new Response(HTML(`
        <div class="hero">
          <h1>Search: "${escapeHtml(q)}"</h1>
          <p>Found ${scored.length} matching papers</p>
        </div>
        <div class="search-box" style="margin-bottom:1rem">
          <input type="text" id="query" value="${escapeHtml(q)}" onkeypress="if(event.key==='Enter')search()">
          <button onclick="search()">Search Again</button>
        </div>
        <div class="results">${resultsHtml}</div>
        <script>function search(){var q=document.getElementById('query').value.trim();if(q)window.location.href='?q='+encodeURIComponent(q)}</script>
      `), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

    } catch (e) {
      return new Response(HTML(`
        <div class="hero">
          <h1>Ask QWAV AI</h1>
          <p style="color:var(--text-muted)">The search backend is initializing. Please try again shortly.</p>
          <p><a href="https://papers.qnfo.org/">Browse the paper catalog</a></p>
        </div>
      `), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  }
};

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
