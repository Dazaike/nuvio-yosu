// PopcornMovies (popcornmovies.st) provider for Nuvio. Plain ES5 promise chains, no async/await, QuickJS-safe.
//
// The whole site sits behind a Cloudflare managed challenge. Passing it once in a normal browser sets an HttpOnly `cf_clearance`
// cookie bound to your public IP and to the browser's User-Agent. Enter both in Plugins > PopcornMovies > Settings (the gear).
// Nothing secret is stored in this file.
//
// Chain (3 hops, then the player talks to api.vidpop.st / cdn.vidpop.st, which need no cookie):
//   GET /watch/<movie|tv>/<tmdbId>[?s=S&e=E]   -> RSC payload contains  tmdbId, playToken ("<expiry ms>.<hmac>")
//   GET /api/sources?type&tmdbId[&season&episode]   header x-play-token   -> { sources:[{label,url,kind,quality}], subtitles:[...] }
//   GET <source.url> (HLS master, preflight)  -> keep servers whose playlist answers, same test the site's own player runs
// Stream URLs are signed opaque tokens on api.vidpop.st. Their AES key endpoint rejects requests without a popcornmovies Referer, so
// every stream carries Referer.

var SITE = 'https://popcornmovies.st';
var REFERER = SITE + '/';
var DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36';
var CACHE_MS = 5 * 60 * 1000;
var PROBE_TIMEOUT_MS = 6000;
var SOURCES_TIMEOUT_MS = 12000;
var BUDGET_MS = 30000;       // stop starting new network work after this; Nuvio kills the whole call at 45 s
var MAX_SUBS = 2;

var cache = {};
var T0 = 0;
function log() {
  var a = ['[PopcornMovies +' + (Date.now() - T0) + 'ms]'];
  for (var i = 0; i < arguments.length; i++) a.push(arguments[i]);
  try { console.log(a.join(' ')); } catch (e) { /* ignore */ }
}

function settings() {
  var s = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
  return {
    cf: typeof s.cf_clearance === 'string' ? s.cf_clearance.replace(/^\s*(cf_clearance=)?/i, '').replace(/[\s;]+$/, '') : '',
    ua: typeof s.user_agent === 'string' && s.user_agent.trim() ? s.user_agent.trim() : DEFAULT_UA,
    probe: s.probe_servers === undefined || s.probe_servers === null ? true : (s.probe_servers === true || s.probe_servers === 'true')
  };
}

// no setTimeout inside Nuvio's QuickJS: the race only exists where a timer does (Node tests); Nuvio relies on OkHttp timeouts + the 45 s cap
function withTimeout(p, ms) {
  if (typeof setTimeout !== 'function') return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout ' + ms + 'ms')); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

function siteHeaders(cfg, extra) {
  var h = { 'User-Agent': cfg.ua, 'Accept': '*/*' };   // no Referer: /api/sources answers 403 {"error":"forbidden"} when one is sent
  if (cfg.cf) h['Cookie'] = 'cf_clearance=' + cfg.cf;
  if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k];
  return h;
}

// ---- hop 1: watch page -> play token ---------------------------------------------------------------------------------------
function getPlayToken(cfg, id, type, season, episode) {
  var url = SITE + '/watch/' + type + '/' + id + (type === 'tv' ? '?s=' + season + '&e=' + episode : '');
  return withTimeout(fetch(url, { headers: siteHeaders(cfg, { 'Accept': 'text/html' }) }), 15000).then(function (r) {
    if (r.status === 403) { log('403 from popcornmovies.st: Cloudflare challenge (cf_clearance missing, expired, other IP or other User-Agent)'); return null; }
    if (r.status !== 200) { log('watch page HTTP ' + r.status); return null; }
    return r.text();
  }).then(function (html) {
    if (!html) return null;
    var tok = /playToken\\?":\\?"(\d{10,}\.[0-9a-f]{32,})/.exec(html);
    var tid = /tmdbId\\?":(\d+)/.exec(html);
    if (!tok || !tid || tid[1] !== String(id)) { log('no player on the watch page: title/episode not on the site'); return null; }
    if (type === 'tv') {
      var s = /\\?"season\\?":(\d+)/.exec(html), e = /\\?"episode\\?":(\d+)/.exec(html);
      if (!s || !e || +s[1] !== +season || +e[1] !== +episode) { log('watch page resolved to another episode'); return null; }
    }
    var t = /\\?"title\\?":\\?"([^"\\]*)/.exec(html.slice(Math.max(0, tok.index - 300), tok.index));
    log('play token ok for ' + (t ? t[1] : '?') + ' (' + type + ' ' + id + ')');
    return tok[1];
  });
}

// ---- hop 2: sources ----------------------------------------------------------------------------------------------------
function getSources(cfg, token, id, type, season, episode, attempt) {
  var qs = 'type=' + type + '&tmdbId=' + id + (type === 'tv' ? '&season=' + season + '&episode=' + episode : '');
  var started = Date.now();
  return withTimeout(fetch(SITE + '/api/sources?' + qs, { headers: siteHeaders(cfg, { 'x-play-token': token }) }), SOURCES_TIMEOUT_MS).then(function (r) {
    if (r.status === 200) return r.json();
    log('sources HTTP ' + r.status + ' after ' + (Date.now() - started) + 'ms (attempt ' + attempt + ')');
    return null;
  }).catch(function (e) {
    log('sources error: ' + (e && e.message ? e.message : e));
    return null;
  }).then(function (j) {
    if (j && j.sources) return j;
    if (attempt < 2 && Date.now() - T0 < BUDGET_MS - SOURCES_TIMEOUT_MS) return getSources(cfg, token, id, type, season, episode, attempt + 1);
    return null;
  });
}

// ---- hop 3: preflight (same test the site's player runs: playlist answers and contains #EXTM3U) ------------------------------
function widthToLabel(w, h) {
  if (!w && !h) return '';
  if (w >= 3200 || h >= 2000) return '2160p';
  if (w >= 2400 || h >= 1300) return '1440p';
  if (w >= 1700 || h >= 900) return '1080p';
  if (w >= 1200 || h >= 600) return '720p';
  if (w >= 800 || h >= 400) return '480p';
  return '360p';
}
var RANK = { '2160p': 2160, '1440p': 1440, '1080p': 1080, '720p': 720, '480p': 480, '360p': 360 };

function resolveUrl(base, rel) {
  if (/^https?:\/\//i.test(rel)) return rel;
  var m = /^(https?:\/\/[^\/?#]+)([^?#]*)/i.exec(base);
  if (!m) return rel;
  if (rel.charAt(0) === '/') return m[1] + rel;
  return m[1] + m[2].replace(/[^\/]*$/, '') + rel;
}

// reads a master playlist: best resolution overall, best non-HEVC resolution, and the URI of the variant to preflight
function analyseMaster(text, masterUrl) {
  var lines = text.split(/\r?\n/), bestAny = null, bestAvc = null, pick = null, pickRank = -1, i;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    var uri = lines[i + 1] && lines[i + 1].charAt(0) !== '#' ? lines[i + 1].trim() : null;
    var res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    var lab = res ? widthToLabel(+res[1], +res[2]) : '';
    var hevc = /CODECS="[^"]*(hvc1|hev1|dvh1|dvhe)/i.test(lines[i]);
    if (lab && (!bestAny || RANK[lab] > RANK[bestAny])) bestAny = lab;
    if (lab && !hevc && (!bestAvc || RANK[lab] > RANK[bestAvc])) bestAvc = lab;
    var r = (hevc ? 0 : 10000) + (RANK[lab] || 1);
    if (uri && r > pickRank) { pickRank = r; pick = resolveUrl(masterUrl, uri); }
  }
  return { any: bestAny, avc: bestAvc, variant: pick };
}

function probe(cfg, src) {
  var base = { src: src, ok: true, label: '', rank: 0 };
  if (!cfg.probe || (src.kind && src.kind !== 'hls')) { base.label = qualityFromSite(src.quality); base.rank = RANK[base.label] || 0; return Promise.resolve(base); }
  var h = { headers: { 'Referer': REFERER } };
  return withTimeout(fetch(src.url, h), PROBE_TIMEOUT_MS).then(function (r) {
    if (r.status !== 200) return { src: src, ok: false, why: 'master HTTP ' + r.status };
    return r.text().then(function (t) {
      if (t.indexOf('#EXTM3U') < 0) return { src: src, ok: false, why: 'master is not an m3u8' };
      var a = analyseMaster(t, src.url);
      var lab = a.any || qualityFromSite(src.quality);
      var good = { src: src, ok: true, label: lab, rank: RANK[a.avc || a.any || qualityFromSite(src.quality)] || 0 };
      if (!a.variant) return good;   // already a media playlist
      // second hop: the variant the player will actually load (an upstream block shows up here, e.g. Cloudflare 403 behind the proxy)
      return withTimeout(fetch(a.variant, h), PROBE_TIMEOUT_MS).then(function (vr) {
        if (vr.status !== 200) return { src: src, ok: false, why: 'variant HTTP ' + vr.status };
        return vr.text().then(function (vt) { return vt.indexOf('#EXTM3U') < 0 ? { src: src, ok: false, why: 'variant is not an m3u8' } : good; });
      });
    });
  }).catch(function (e) { return { src: src, ok: false, why: String(e && e.message ? e.message : e) }; });
}

function qualityFromSite(q) {
  q = String(q || '').toLowerCase();
  if (/^\d{3,4}p?$/.test(q)) return (q.charAt(q.length - 1) === 'p' ? q : q + 'p');
  if (q === 'fhd') return '1080p';
  if (q === 'uhd' || q === '4k') return '2160p';
  if (q === 'hd') return '720p';
  return '';
}

// Runs the preflights in parallel. Nuvio's QuickJS has no timers, so a hung server cannot be cut off; instead the list is returned as soon
// as every server answered, or, once 3 s have passed, when at most one server is still unanswered and two others verified (the straggler,
// typically an upstream 504 that takes 20+ s, is left out; its request is simply not waited for).
function probeAll(cfg, srcs) {
  return new Promise(function (resolve) {
    var res = [], done = 0, finished = false, t0 = Date.now();
    function finish() {
      if (finished) return;
      finished = true;
      var out = [], i;
      for (i = 0; i < srcs.length; i++) {
        if (res[i]) out.push(res[i]);
        else { log('left out (no answer yet): ' + (srcs[i].label || srcs[i].provider)); }
      }
      resolve(out);
    }
    if (!srcs.length) return finish();
    srcs.forEach(function (s, i) {
      probe(cfg, s).then(function (r) {
        res[i] = r; done++;
        if (done === srcs.length) return finish();
        var okN = 0, j;
        for (j = 0; j < srcs.length; j++) if (res[j] && res[j].ok) okN++;
        if (srcs.length - done <= 1 && okN >= 2 && Date.now() - t0 >= 3000) finish();
      });
    });
  });
}

// ---- assemble --------------------------------------------------------------------------------------------------------------
function buildStreams(cfg, data) {
  var seen = {}, srcs = [], i;
  for (i = 0; i < data.sources.length; i++) {
    var s = data.sources[i];
    if (!s || typeof s.url !== 'string' || seen[s.url]) continue;
    seen[s.url] = 1; srcs.push(s);
  }
  return probeAll(cfg, srcs).then(function (res) {
    var ok = [], dead = [];
    res.forEach(function (r) { (r.ok ? ok : dead).push(r); });
    if (dead.length) log('dropped ' + dead.map(function (d) { return (d.src.label || d.src.provider) + ' (' + d.why + ')'; }).join(', '));
    if (!ok.length) return [];
    // name them after the real server, number repeats ("Lyra", "Lyra (2)")
    var count = {};
    ok.forEach(function (r) {
      var n = r.src.label || r.src.provider || 'Server';
      count[n] = (count[n] || 0) + 1;
      r.name = count[n] > 1 ? n + ' (' + count[n] + ')' : n;
    });
    var subs = [];
    (data.subtitles || []).forEach(function (t) {
      if (subs.length >= MAX_SUBS || !t || typeof t.url !== 'string') return;
      if (!/^en([-_]|$)/i.test(String(t.language || '')) && !/^english$/i.test(String(t.label || ''))) return;   // plain English only (no dub-SDH variants of unknown format)
      subs.push({ url: t.url, lang: 'en', language: 'en', label: (t.label || 'English') + (subs.length ? ' ' + (subs.length + 1) : ''), name: 'PopcornMovies' });
    });
    var headers = { 'Referer': REFERER };
    function mk(name, title, r) {
      return { name: name, title: title, url: r.src.url, quality: r.label || 'Auto', headers: headers, subtitles: subs };
    }
    // best = highest AVC resolution (an HEVC-only 4K variant does not make a server the default), ties keep the site's order
    var best = null;
    ok.forEach(function (r) { if (!best || r.rank > best.rank) best = r; });
    var out = [mk('PopcornMovies Auto (Best)', 'Auto (Best): ' + best.name + (best.label ? ' ' + best.label : ''), best)];
    ok.forEach(function (r) { out.push(mk('PopcornMovies ' + r.name, r.name + (r.label ? ' ' + r.label : ''), r)); });
    return out;
  });
}

function fetchStreams(cfg, id, type, season, episode) {
  return getPlayToken(cfg, id, type, season, episode).then(function (token) {
    if (!token) return [];
    return getSources(cfg, token, id, type, season, episode, 1).then(function (data) {
      if (!data || !data.sources || !data.sources.length) { log('no sources'); return []; }
      log(data.sources.length + ' sources from the site: ' + data.sources.map(function (s) { return s.label + ' ' + s.quality; }).join(', '));
      return buildStreams(cfg, data);
    });
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    T0 = Date.now();
    var type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : (mediaType === 'movie' ? 'movie' : null);
    var id = String(tmdbId === undefined || tmdbId === null ? '' : tmdbId).trim();
    if (!type || !/^\d{1,10}$/.test(id)) { log('bad input ' + tmdbId + ' ' + mediaType); return Promise.resolve([]); }
    var s = type === 'tv' ? (parseInt(season, 10) >= 0 ? parseInt(season, 10) : 1) : 0;
    var e = type === 'tv' ? (parseInt(episode, 10) > 0 ? parseInt(episode, 10) : 1) : 0;
    var cfg = settings();
    var key = type + ':' + id + ':' + s + ':' + e + ':' + (cfg.probe ? 1 : 0);
    var hit = cache[key];
    if (hit && Date.now() - hit.t < CACHE_MS) { log('cache hit ' + key); return Promise.resolve(hit.v); }
    return fetchStreams(cfg, id, type, s, e).then(function (v) {
      if (v.length) cache[key] = { t: Date.now(), v: v };
      log('done: ' + v.length + ' stream(s)');
      return v;
    }).catch(function (err) {
      log('error: ' + (err && err.message ? err.message : err));
      return [];
    });
  } catch (err) {
    return Promise.resolve([]);
  }
}

function onSettings() {
  return [
    { type: 'header', label: 'PopcornMovies' },
    { type: 'info', label: 'popcornmovies.st is behind a Cloudflare check. Open it in a normal browser on the same network as this device, pass the check, then copy the cf_clearance cookie (DevTools > Application > Cookies, HttpOnly so not visible from the console) and the browser User-Agent (console: navigator.userAgent). The cookie only works from the connection and User-Agent that earned it.' },
    { type: 'text', key: 'cf_clearance', label: 'cf_clearance cookie', placeholder: 'paste the cf_clearance value', description: 'Cloudflare pass for popcornmovies.st (not a login).' },
    { type: 'text', key: 'user_agent', label: 'User-Agent', placeholder: 'Mozilla/5.0 ...', description: 'Exact User-Agent of the browser the cookie came from.' },
    { type: 'toggle', key: 'probe_servers', label: 'Check servers before listing', description: 'Drops servers whose playlist does not answer (adds up to 6 s, keeps the list free of dead links).', defaultValue: true }
  ];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams, onSettings: onSettings };
else { global.getStreams = getStreams; global.onSettings = onSettings; }

// ---- Yosu user settings (appended to every provider by build.js; edit tail.js, not providers/) ----
// Settings gear of the plugin row: resolution toggles, size limits, blocked words, hide subtitles, sort.
// Values arrive in SCRAPER_SETTINGS (per provider). Streams whose resolution or size cannot be read are kept.
(function () {
  var RES = [
    { key: 'res_4k', id: '4k', label: '4K / 2160p' },
    { key: 'res_1080p', id: '1080p', label: '1080p' },
    { key: 'res_720p', id: '720p', label: '720p' },
    { key: 'res_480p', id: '480p', label: '480p' },
    { key: 'res_360p', id: '360p', label: '360p' }
  ];
  var RANK = { '4k': 0, '1080p': 1, '720p': 2, '480p': 3, '360p': 4, unknown: 5 };

  function settings() { return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {}; }
  function on(v, dflt) { return v === undefined || v === null || v === '' ? dflt : (v === true || v === 'true'); }
  function numOrNull(v) { var n = parseFloat(v); return isFinite(n) && n >= 0 ? n : null; }
  function textOf(s) { return [s.name, s.title, s.quality, s.size].filter(Boolean).join(' '); }
  function parseRes(t) {
    if (/2160p|\b4k\b|\buhd\b/i.test(t)) return '4k';
    var r = ['1080p', '720p', '480p', '360p'];
    for (var i = 0; i < r.length; i++) if (t.toLowerCase().indexOf(r[i]) >= 0) return r[i];
    var h = /\b(\d{3,4})p\b/i.exec(t);   // odd heights (1079p, 800p) go to the nearest bucket
    if (h) { var n = +h[1]; return n >= 1800 ? '4k' : n >= 900 ? '1080p' : n >= 600 ? '720p' : n >= 420 ? '480p' : n >= 300 ? '360p' : 'unknown'; }
    return 'unknown';
  }
  function parseGB(t) {
    var m = /(\d+(?:\.\d+)?)\s*(GB|MB)/i.exec(t);
    if (!m) return null;
    var n = parseFloat(m[1]);
    return m[2].toUpperCase() === 'MB' ? n / 1024 : n;
  }

  function apply(streams) {
    if (!Array.isArray(streams)) return streams;
    var st = settings();
    var allowed = {};
    RES.forEach(function (r) { allowed[r.id] = on(st[r.key], true); });
    var minGB = numOrNull(st.min_gb), maxGB = numOrNull(st.max_gb);
    var block = String(st.block || '').toLowerCase().split(',').map(function (b) { return b.trim(); }).filter(Boolean);
    var hideSubs = on(st.hide_subs, false);
    var sort = st.sort === 'quality' || st.sort === 'size' ? st.sort : 'provider';

    var rows = [];
    streams.forEach(function (s, n) {
      if (!s) return;
      var t = textOf(s), res = parseRes(t), gb = parseGB(t), low = t.toLowerCase();
      if (res !== 'unknown' && !allowed[res]) return;
      if (gb !== null && ((minGB !== null && gb < minGB) || (maxGB !== null && gb > maxGB))) return;
      if (block.some(function (b) { return low.indexOf(b) >= 0; })) return;
      var out = s;
      if (hideSubs && s.subtitles) { out = {}; for (var k in s) if (k !== 'subtitles') out[k] = s[k]; }
      rows.push({ s: out, r: RANK[res], gb: gb, n: n, a: /\bauto\b/i.test(s.name || s.title || '') ? 0 : 1 });
    });
    // "Auto (Best)" entries stay on top whichever sort is chosen
    if (sort === 'quality') rows.sort(function (a, b) { return a.a - b.a || a.r - b.r || a.n - b.n; });
    else if (sort === 'size') rows.sort(function (a, b) { return a.a - b.a || (a.gb === null) - (b.gb === null) || (b.gb || 0) - (a.gb || 0) || a.n - b.n; });
    return rows.map(function (x) { return x.s; });
  }

  // The provider's own settings (cookie, User-Agent, server toggles) come first and are kept as they are.
  function onSettings() {
    var own = typeof ownSettings === 'function' ? ownSettings() : [];
    var ownKeys = own.map(function (o) { return o.key; });
    var out = own.slice();
    out.push({ type: 'header', label: 'Resolutions to show' });
    RES.forEach(function (r) { out.push({ type: 'toggle', key: r.key, label: r.label, defaultValue: true }); });
    out.push({ type: 'info', label: 'Streams with no detectable resolution or size are always kept.' });
    out.push({ type: 'header', label: 'Size' });
    out.push({ type: 'text', key: 'min_gb', label: 'Minimum size (GB)', placeholder: 'no minimum' });
    out.push({ type: 'text', key: 'max_gb', label: 'Maximum size (GB)', placeholder: 'no maximum' });
    out.push({ type: 'header', label: 'Filtering' });
    out.push({ type: 'text', key: 'block', label: 'Blocked words', placeholder: 'cam, hdcam, hindi', description: 'Comma separated. A stream is hidden if its name or title contains any of them.' });
    if (ownKeys.indexOf('subtitles') < 0) out.push({ type: 'toggle', key: 'hide_subs', label: 'Hide subtitles', description: 'Drop the subtitles a stream comes with.', defaultValue: false });
    out.push({
      type: 'select', key: 'sort', label: 'Sort', defaultValue: 'provider',
      options: [
        { label: "Provider's order", value: 'provider' },
        { label: 'Best quality first', value: 'quality' },
        { label: 'Largest first', value: 'size' }
      ]
    });
    return out;
  }

  var hasModule = typeof module !== 'undefined' && module.exports;
  var host = hasModule ? module.exports : global;
  var inner = host.getStreams;
  var ownSettings = host.onSettings;
  function getStreams() { return Promise.resolve(inner.apply(null, arguments)).then(apply); }
  if (hasModule) module.exports = { getStreams: getStreams, onSettings: onSettings };
  else { global.getStreams = getStreams; global.onSettings = onSettings; }
})();
