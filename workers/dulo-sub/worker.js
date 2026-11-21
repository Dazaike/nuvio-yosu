// Cloudflare Worker: GET /sub?u=<dulo subtitle url>. Dulo refuses subtitle links that carry no dulo.mov Referer, and
// players do not send one, so src/dulo.js points its subtitle URLs here. Only dulo's own zstream-proxy payload links
// are fetched (host check below), so this is not an open proxy. Deploy: cd workers/dulo-sub && npx wrangler deploy
const SITE = 'https://dulo.mov';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const PLAY_HEADERS = { Referer: SITE + '/', Origin: SITE, 'User-Agent': UA };
const TIMEOUT_MS = 10000;
const CONFIG_TTL = 10 * 60 * 1000;
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

// The proxy domain is published by the site and changes now and then.
let domain = '2wwlgkfo-31a.workers.dev';
let loadedAt = 0;
async function loadDomain() {
  if (Date.now() - loadedAt < CONFIG_TTL) return;
  try {
    const r = await fetch(SITE + '/dulo-config.js', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(5000) });
    const d = /WORKER_DOMAIN:\s*'([a-z0-9.-]+)'/i.exec(r.ok ? await r.text() : '');
    if (d) { domain = d[1].toLowerCase(); loadedAt = Date.now(); }
  } catch { /* keep last known value */ }
}

async function subtitle(u) {
  await loadDomain();
  let t;
  try { t = new URL(u); } catch { return null; }
  const ok = t.protocol === 'https:' && t.hostname.endsWith('.' + domain) && /^zstream-proxy\d?\./.test(t.hostname) && t.searchParams.has('payload');
  if (!ok) return null;
  const r = await fetch(t.href, { headers: PLAY_HEADERS, signal: AbortSignal.timeout(TIMEOUT_MS) }).catch(() => null);
  return r && r.ok ? await r.text() : null;
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { ...CORS } });
    const url = new URL(request.url);
    if (url.pathname !== '/sub') return new Response('not found', { status: 404, headers: CORS });
    const text = await subtitle(url.searchParams.get('u') || '').catch(() => null);
    if (text == null) return new Response('subtitle unavailable', { status: 404, headers: CORS });
    return new Response(text, { status: 200, headers: { ...CORS, 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'max-age=3600' } });
  },
};
