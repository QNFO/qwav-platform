// papers-server Worker — serves dynamic paper pages from D1 + R2
// QNFO Design System v3.0 | Cloudflare Workers | 2026-07-10

const DESIGN = `
<style>
:root { --blue: #1a56db; --blue-dark: #1040a8; --blue-light: #dbeafe; --blue-subtle: #eff6ff; --text: #1a1a2e; --text-muted: #6b7280; --bg: #ffffff; --border: #e5e7eb; --card-bg: #f9fafb; --max-w: 960px; --radius: 8px; }
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Source Serif 4', Georgia, serif; color: var(--text); background: var(--bg); line-height: 1.7; font-size: 17px; }
h1, h2, h3, nav, .meta { font-family: 'Inter', system-ui, sans-serif; }
nav { position: sticky; top: 0; background: rgba(255,255,255,0.95); backdrop-filter: blur(12px); border-bottom: 1px solid var(--border); padding: .75rem 0; z-index: 100; }
nav .inner { max-width: var(--max-w); margin: 0 auto; padding: 0 1.5rem; display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
nav a { color: var(--blue); text-decoration: none; font-weight: 500; font-size: .9rem; }
nav a:hover { color: var(--blue-dark); }
main { max-width: var(--max-w); margin: 0 auto; padding: 2rem 1.5rem; }
h1 { font-size: 1.75rem; font-weight: 700; margin-bottom: .5rem; }
.abstract { color: var(--text-muted); font-style: italic; margin: 1rem 0; padding: 1rem; background: var(--blue-subtle); border-radius: var(--radius); border-left: 3px solid var(--blue); }
.meta { color: var(--text-muted); font-size: .85rem; margin-bottom: 1.5rem; }
.meta a { color: var(--blue); }
.badge { display: inline-block; padding: .15em .5em; border-radius: 3px; font-size: .75rem; font-weight: 500; margin-right: .5rem; }
.badge-doi { background: var(--blue-light); color: var(--blue); }
.paper-content { margin-top: 2rem; }
.paper-content h1, .paper-content h2, .paper-content h3 { color: var(--blue-dark); }
.paper-content pre { background: #f5f5f5; padding: 1rem; border-radius: var(--radius); overflow-x: auto; }
.paper-content code { background: #f0f0f0; padding: .15em .3em; border-radius: 3px; font-size: .9em; }
footer { margin-top: 3rem; padding: 1.5rem; border-top: 1px solid var(--border); text-align: center; font-size: .85rem; color: var(--text-muted); font-family: 'Inter', sans-serif; }
footer a { color: var(--blue); }
.card { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.25rem 1.5rem; margin-bottom: .75rem; transition: box-shadow .15s; }
.card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
</style>`;

const NAV = `
<nav><div class="inner">
<a href="https://qnfo.org"><strong>QNFO</strong></a>
<a href="https://papers.qnfo.org/">Papers</a>
<a href="https://deep.qwav.tech/">QWAV Deep</a>
<a href="https://legal.qnfo.org/">Legal</a>
</div></nav>`;

const MATHJAX = `
<script id="MathJax-config">
window.MathJax = {
  tex: { inlineMath: [["$","$"],["\\\\(\\","\\\\)"]], displayMath: [["$$","$$"],["\\\\[","\\\\]"]], macros: {} },
  options: { ignoreHtmlClass: "no-mathjax" }
};
</script>
<script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Paper detail: /papers/<slug>/
    const paperMatch = path.match(/^\/papers\/([^/]+)\/?$/);
    if (paperMatch) {
      const slug = paperMatch[1];
      try {
        // Query D1 for paper metadata
        const stmt = env.DB.prepare('SELECT * FROM papers WHERE slug = ? OR id = ?').bind(slug, slug);
        const result = await stmt.first();
        
        if (!result) {
          return new Response(renderNotFound(slug), {
            status: 404,
            headers: { 'Content-Type': 'text/html; charset=utf-8' }
          });
        }

        // Try to fetch markdown from R2
        let markdown = null;
        const doi = result.doi || '';
        const published = result.published || result.created_at || '';
        // Try known R2 paths for the paper
        const r2Paths = [
          `qnfo/releases/${published.substring(0,7).replace('-','/')}/${slug}/paper.md`,
          `qnfo/releases/${published.substring(0,4)}/${published.substring(5,7)}/${slug}/paper.md`,
          `qnfo/papers/${slug}/paper.md`,
          `qnfo/papers/${result.id}/paper.md`
        ];
        
        for (const r2Path of r2Paths) {
          try {
            const obj = await env.PAPERS_BUCKET.get(r2Path);
            if (obj) {
              markdown = await obj.text();
              break;
            }
          } catch (e) { /* try next path */ }
        }

        return new Response(renderPaper(result, markdown, slug), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      } catch (e) {
        return new Response(renderError(slug, e.message), {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    // Root index
    if (path === '/' || path === '') {
      try {
        const stmt = env.DB.prepare('SELECT slug, title, doi, abstract FROM papers WHERE slug IS NOT NULL AND slug != "None" ORDER BY created_at DESC LIMIT 100');
        const { results } = await stmt.all();
        return new Response(renderIndex(results), {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      } catch (e) {
        return new Response(renderError('index', e.message), {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    // 404
    return new Response(renderNotFound(path), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    });
  }
};

function renderIndex(papers) {
  const cards = papers.map(p => `
<div class="card">
  <h3><a href="/papers/${p.slug}/">${escapeHtml(p.title || 'Untitled')}</a></h3>
  <p style="font-size:.9rem;color:var(--text-muted)">${escapeHtml((p.abstract || '').slice(0, 200))}${(p.abstract||'').length>200?'...':''}</p>
  <div class="meta">${p.doi ? `<span class="badge badge-doi">DOI: ${escapeHtml(p.doi)}</span>` : ''}</div>
</div>`).join('\n');

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>QNFO Research Papers</title><meta name="description" content="QNFO Research Papers — ${papers.length} publications"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">${DESIGN}</head><body>${NAV}<main><h1>QNFO Research Papers</h1><p style="color:var(--text-muted);margin-bottom:1.5rem">${papers.length} papers</p>${cards}</main><footer><p>QNFO Research Hub — <a href="https://qnfo.org">qnfo.org</a></p></footer>${MATHJAX}</body></html>`;
}

function renderPaper(paper, markdown, slug) {
  const title = paper.title || 'Untitled';
  const doi = paper.doi || '';
  const abstract = paper.abstract || '';
  
  let bodyHtml = '';
  if (markdown) {
    // Simple markdown-to-HTML conversion
    bodyHtml = markdown
      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(.+)$/gm, (m, text) => {
        if (text.startsWith('<h') || text.startsWith('</p>') || text.startsWith('<p>')) return m;
        if (text.trim() === '') return '';
        return `<p>${text}</p>`;
      });
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>${escapeHtml(title)} — QNFO</title><meta name="description" content="${escapeHtml(abstract.slice(0,160))}">${doi ? `<meta name="citation_doi" content="${escapeHtml(doi)}">` : ''}<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400&display=swap" rel="stylesheet">${DESIGN}</head><body>${NAV}<main><h1>${escapeHtml(title)}</h1>${doi ? `<div class="meta"><span class="badge badge-doi">DOI: ${escapeHtml(doi)}</span></div>` : ''}${abstract ? `<div class="abstract">${escapeHtml(abstract)}</div>` : ''}${bodyHtml ? `<div class="paper-content">${bodyHtml}</div>` : '<p style="color:var(--text-muted)">Full paper content is being processed. DOI links to Zenodo for the complete PDF.</p>'}</main><footer><p>QNFO Research Hub — <a href="https://qnfo.org">qnfo.org</a> | <a href="https://legal.qnfo.org/">QNFO-ULA License</a></p></footer>${MATHJAX}</body></html>`;
}

function renderNotFound(path) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>404 — QNFO</title>${DESIGN}</head><body>${NAV}<main><h1>404 — Not Found</h1><p>The page <code>${escapeHtml(path)}</code> was not found.</p><p><a href="https://papers.qnfo.org/">Browse the paper catalog</a> or <a href="https://qnfo.org/">return to QNFO</a>.</p></main></body></html>`;
}

function renderError(path, msg) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Error — QNFO</title>${DESIGN}</head><body>${NAV}<main><h1>500 — Server Error</h1><p>An error occurred while processing <code>${escapeHtml(path)}</code>.</p><p style="color:var(--text-muted)">${escapeHtml(msg)}</p><p><a href="https://papers.qnfo.org/">Browse the paper catalog</a></p></main></body></html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
