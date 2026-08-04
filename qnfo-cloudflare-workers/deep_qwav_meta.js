// deep-qwav-meta Worker — transparent proxy that injects OG+JSON-LD into deep.qwav.tech
// Fetches from qwav Pages project, injects meta tags, returns modified HTML
// Cloudflare Workers | 2026-07-10

const ORIGIN = 'https://qwav.pages.dev';

const OG_TAGS = `
<meta property="og:title" content="QWAV Deep — Research Feed">
<meta property="og:description" content="QNFO research feed on ultrametric quantum computing, p-adic physics, and quantum foundations. Browse papers with DOIs and AI-powered Q&A.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://deep.qwav.tech/">
<meta property="og:site_name" content="QWAV Deep">
<meta property="og:image" content="https://qnfo.org/favicon.ico">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="QWAV Deep — Research Feed">
<meta name="twitter:description" content="Browse QNFO research papers with AI-powered Q&A.">`;

const JSON_LD = `
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "QWAV Deep",
  "url": "https://deep.qwav.tech/",
  "description": "QNFO research feed on ultrametric quantum computing, p-adic physics, and quantum foundations.",
  "potentialAction": {
    "@type": "SearchAction",
    "target": "https://ask.qwav.tech/?q={search_term_string}",
    "query-input": "required name=search_term_string"
  }
}
</script>`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    // Build origin URL (keep same path)
    const originUrl = ORIGIN + url.pathname + url.search;
    
    // Fetch from origin
    let response;
    try {
      response = await fetch(originUrl, {
        method: request.method,
        headers: request.headers,
        redirect: 'follow'
      });
    } catch (e) {
      return new Response('Error fetching origin: ' + e.message, { status: 502 });
    }
    
    // Only modify HTML responses
    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.includes('text/html')) {
      return response;
    }
    
    // Read and modify HTML
    let html = await response.text();
    
    // Inject OG tags + JSON-LD before </head>
    const injection = OG_TAGS + '\n' + JSON_LD;
    if (html.includes('</head>')) {
      html = html.replace('</head>', injection + '\n</head>');
    } else if (html.includes('<head>')) {
      html = html.replace('<head>', '<head>\n' + injection);
    }
    
    return new Response(html, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }
};
