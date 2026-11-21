// Dulo (dulo.mov) provider for Nuvio. Promise-based on purpose (no async/await).
//
// How dulo.mov serves video (reverse-engineered, see README):
//  1. "Pickle" = ZCDN worker:  GET <zcdn>/cdn?tmdb=ID&type=movie|tv[&season=S&episode=E]
//       -> { ready:true, url:".../play/<token>/~<token>" }  an HLS master playlist (up to 4K, fMP4).
//       The link is bound to the caller's IP, so it only works when it is requested from the device that plays it.
//  2. Everything else = GET <zstream-proxy>/?destination=https://dulo.mov/api/streams/resolve?tmdbId=..&type=..&progressive=true
//       -> { found, pending, sources:[{label,url,captions[]}] }  (Zephyr / Breeze / Ripple / Cobalt ...).
//       Poll while pending:true. url = HLS media playlist whose segments are self-contained proxy links.
//  Playlists, segments and subtitles are refused (403 "nope") unless Referer or Origin is dulo.mov.
//  The worker host domain changes now and then; the site publishes the current one in /dulo-config.js.
var SITE = 'https://dulo.mov';
var DEFAULT_DOMAIN = 'e6dd8d160-edge.workers.dev';
var DEFAULT_TMDB = 'https://epfopf2vba.e6dd8d160-edge.workers.dev';
var SUB_PROXY = 'https://yosu-dulo-sub.dazaike.workers.dev/sub?u='; // adds the Referer that subtitle links require (source: workers/dulo-sub); '' = link directly
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
var HEADERS = { 'User-Agent': UA, 'Origin': SITE, 'Referer': SITE + '/', 'Accept': 'application/json' };
var PLAY_HEADERS = { 'User-Agent': UA, 'Origin': SITE, 'Referer': SITE + '/' };
var CONFIG_TTL = 10 * 60 * 1000;
var BUDGET_WITH_ZCDN = 9000;    // how long to keep polling resolve when ZCDN already gave a stream
var BUDGET_WITHOUT_ZCDN = 26000;
var POLL_GAP = 500;             // ms between resolve polls (the site itself polls every 250ms)
var MAX_POLLS = 60;             // with timers; 25 without (see pause)
var SHOW_ALL = true;            // list every source after the Auto pick
var DEBUG = true;
function log() { if (DEBUG) console.log.apply(console, ['[Dulo]'].concat([].slice.call(arguments))); }

var cfg = { domain: DEFAULT_DOMAIN, tmdb: DEFAULT_TMDB, at: 0 };

function pick(prefix) { return 'https://' + prefix + (1 + Math.floor(Math.random() * 3)) + '.' + cfg.domain; }

function getJson(url) {
  return fetch(url, { headers: HEADERS })
    .then(function (r) { if (!r.ok) { log('HTTP', r.status, url.slice(0, 90)); return null; } return r.json(); })
    .catch(function (e) { log('ERROR', String(e && e.message || e), url.slice(0, 90)); return null; });
}

// Current worker domain / TMDB gateway, as published by the site. Falls back to the last known values.
function loadConfig() {
  if (Date.now() - cfg.at < CONFIG_TTL) return Promise.resolve();
  return fetch(SITE + '/dulo-config.js', { headers: { 'User-Agent': UA } })
    .then(function (r) { return r.ok ? r.text() : ''; })
    .then(function (t) {
      var d = /WORKER_DOMAIN:\s*'([a-z0-9.-]+)'/i.exec(t || '');
      var m = /TMDB_PROXY_URL:\s*'(https:\/\/[a-z0-9.-]+)'/i.exec(t || '');
      if (d) cfg.domain = d[1].toLowerCase();
      if (m) cfg.tmdb = m[1].toLowerCase();
      if (d) cfg.at = Date.now();
      log('config', cfg.domain, cfg.tmdb, d ? '(live)' : '(fallback)');
    })
    .catch(function (e) { log('config ERROR', String(e && e.message || e)); });
}

// ---- Pickle (ZCDN) -------------------------------------------------------
function zcdn(tmdbId, isTv, season, episode, tries) {
  var q = '/cdn?tmdb=' + encodeURIComponent(tmdbId) + '&type=' + (isTv ? 'tv&season=' + season + '&episode=' + episode : 'movie');
  return getJson(pick('zcdn') + q).then(function (j) {
    if (j && j.ready === true && typeof j.url === 'string' && /^https:\/\//.test(j.url) && j.url.indexOf('/play/') > 0) return j.url;
    if (j && j.ready === false) log('zcdn not ready', j.status);
    return tries > 1 ? zcdn(tmdbId, isTv, season, episode, tries - 1) : null;
  });
}

// ---- metadata the site sends along with resolve (title / year / runtime) ----
function metadata(tmdbId, isTv, season, episode) {
  var base = cfg.tmdb + '/3/';
  if (!isTv) {
    return getJson(base + 'movie/' + tmdbId).then(function (m) {
      return m ? { title: m.title, year: (m.release_date || '').slice(0, 4), runtime: m.runtime } : {};
    });
  }
  return Promise.all([getJson(base + 'tv/' + tmdbId), getJson(base + 'tv/' + tmdbId + '/season/' + season)]).then(function (r) {
    var t = r[0] || {}, s = r[1] || {}, rt = 0;
    (s.episodes || []).forEach(function (e) { if (e.episode_number === episode && e.runtime) rt = e.runtime; });
    return { title: t.name, year: (t.first_air_date || '').slice(0, 4), runtime: rt };
  });
}

function qs(v) { return encodeURIComponent(String(v)).replace(/%20/g, '+'); }

function resolveQuery(tmdbId, isTv, season, episode, md) {
  var q = 'tmdbId=' + tmdbId + '&type=' + (isTv ? 'tv' : 'movie') + '&progressive=true';
  if (isTv) q += '&seasonId=' + season + '&episodeId=' + episode;
  if (md.title) q += '&title=' + qs(md.title);
  if (md.year) q += '&year=' + qs(md.year);
  if (md.runtime > 0) q += '&runtime=' + Math.round(md.runtime);
  return q;
}

// Pause between polls. If the runtime has no setTimeout we simply poll back to back, but then with a lower cap.
var HAS_TIMER = typeof setTimeout === 'function';
function pause(ms) { return HAS_TIMER ? new Promise(function (r) { setTimeout(r, ms); }) : Promise.resolve(); }

// Merge source lists, one entry per label; prefer the entry that carries captions.
function mergeSources(lists) {
  var out = [], idx = {};
  lists.forEach(function (list) {
    (list || []).forEach(function (s) {
      if (!s || !s.url) return;
      var k = s.label || s.url;
      if (idx[k] === undefined) { idx[k] = out.length; out.push(s); }
      else if (!(out[idx[k]].captions || []).length && (s.captions || []).length) out[idx[k]] = s;
    });
  });
  return out;
}

// Poll resolve while pending:true; sources accumulate progressively (usually 1-20s for an uncached title).
function resolve(query, state) {
  var started = Date.now(), best = [], polls = 0, proxy = pick('zstream-proxy');
  var cap = HAS_TIMER ? MAX_POLLS : 25;
  function step() {
    polls++;
    var url = proxy + '/?destination=' + encodeURIComponent(SITE + '/api/streams/resolve?' + query);
    return getJson(url).then(function (j) {
      if (!j) { proxy = pick('zstream-proxy'); if (polls >= 3) return best; return step(); }
      if (j.sources && j.sources.length) best = j.sources;
      log('resolve poll', polls, 'pending', j.pending, 'sources', (j.sources || []).length, (Date.now() - started) + 'ms');
      var budget = state.zcdn ? BUDGET_WITH_ZCDN : BUDGET_WITHOUT_ZCDN;
      if (j.pending && polls < cap && Date.now() - started < budget) return pause(POLL_GAP).then(step);
      return best;
    });
  }
  return step();
}

// ---- ranking / output ----------------------------------------------------
function height(label) {
  if (/\b4K\b/i.test(label)) return 2160;
  var m = /(\d{3,4})\s*p/i.exec(label);
  return m ? parseInt(m[1], 10) : 720; // unlabeled = assume 720
}

function subtitlesOf(sources) {
  var out = [], seen = {};
  sources.forEach(function (s) {
    (s.captions || []).forEach(function (c) {
      var lang = String(c.language || '').toLowerCase();
      if (!c.url || seen[lang]) return;
      seen[lang] = 1;
      out.push({ url: SUB_PROXY ? SUB_PROXY + encodeURIComponent(c.url) : c.url, label: c.display || c.language, lang: lang });
    });
  });
  out.sort(function (a, b) { return (b.lang === 'en') - (a.lang === 'en'); });
  return out;
}

function score(c) {
  var s = c.height;
  if (c.subs) s += 50;
  if (c.kind === 'zcdn') s += 1000; // adaptive up to 4K, fMP4
  return s;
}

function toStream(c, name, subs) {
  return {
    name: name || ('Dulo - ' + c.label),
    title: c.label + (subs.length ? ' | ' + subs.length + ' subs' : ''),
    description: c.label + ' | ' + (c.kind === 'zcdn' ? 'ZCDN adaptive HLS' : 'HLS via dulo proxy'),
    url: c.url,
    quality: c.quality,
    headers: PLAY_HEADERS,
    subtitles: subs
  };
}

function getStreams(tmdbId, mediaType, season, episode) {
  log('getStreams', tmdbId, mediaType, season, episode);
  var isTv = mediaType === 'tv';
  season = parseInt(season, 10) || 1;
  episode = parseInt(episode, 10) || 1;
  var state = { zcdn: null };

  return loadConfig().then(function () {
    var pZ = zcdn(tmdbId, isTv, season, episode, 2).then(function (u) { state.zcdn = u; return u; });
    // dulo caches/scrapes per exact query: the bare query and the title/year/runtime query surface different servers.
    var qBare = resolveQuery(tmdbId, isTv, season, episode, {});
    var rBare = resolve(qBare, state).catch(function () { return []; });
    var rMeta = metadata(tmdbId, isTv, season, episode)
      .catch(function () { return {}; })
      .then(function (md) {
        var q = resolveQuery(tmdbId, isTv, season, episode, md);
        return q === qBare ? [] : resolve(q, state);
      })
      .catch(function () { return []; });
    var pR = Promise.all([rBare, rMeta]).then(mergeSources);
    return Promise.all([pZ, pR]);
  }).then(function (res) {
    var zurl = res[0], sources = res[1] || [];
    var cands = [];
    if (zurl) cands.push({ kind: 'zcdn', label: 'Pickle', quality: 'Auto (up to 4K)', height: 2160, url: zurl, subs: false });
    var seen = {};
    sources.forEach(function (s) {
      if (!s || !s.url || seen[s.url]) return;
      seen[s.url] = 1;
      var h = height(s.label || '');
      cands.push({ kind: 'resolve', label: s.label || 'Dulo', quality: /\d{3,4}p|4K/i.test(s.label || '') ? (h === 2160 ? '4K' : h + 'p') : 'Auto', height: h, url: s.url, subs: (s.captions || []).length > 0 });
    });
    log('candidates', cands.length);
    if (!cands.length) return [];
    var subs = subtitlesOf(sources);
    cands.sort(function (a, b) { return score(b) - score(a); });
    var out = [toStream(cands[0], 'Dulo - Auto (Best)', subs)];
    out[0].title = cands[0].label + ' (auto pick)' + (subs.length ? ' | ' + subs.length + ' subs' : '');
    if (SHOW_ALL) cands.slice(1).forEach(function (c) { out.push(toStream(c, null, subs)); });
    return out;
  }).catch(function (e) { log('FATAL', String(e && e.message || e)); return []; });
}

if (typeof module !== 'undefined' && module.exports) module.exports = { getStreams: getStreams };
else global.getStreams = getStreams;

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
