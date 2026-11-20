// Cno (beta.cno.to, "Sky") provider for Nuvio. Promise chains and plain ES5 on purpose (no async/await), runs in QuickJS.
//
// The site is addressed by TMDB id, so there is no search and no TMDB key needed:
//   movie / tv episode  ->  GET /screen/master/movie/<tmdb>   |   /screen/master/tv/<tmdb>/<season>/<episode>      (HLS master, fMP4, up to 4K)
//   subtitles           ->  GET /screen/subs/movie/<tmdb>/en.vtt   |   /screen/subs/tv/<tmdb>/<s>/<e>/en.vtt
//   anime (library)     ->  GET /screen-api/tv/<tmdb>/episode/<s>/<e>?site=dexter   (gives the AniList id + episode number)
//                           GET /anime/<anilistId>   (301 -> /anime/<slug>-<id>, which tells the folder name)
//                           GET /hls/<id>-<slug>/E<nnnn>/master.m3u8   (multi-audio, multi-subtitle HLS)
// No cookie is needed for any of it (tested). The /hls/ host path is the one place with a Cloudflare rule: it answers 403 to a
// User-Agent that has neither "Chrome" nor "Safari" in it, so every request and every returned stream carries a Chrome User-Agent.

var SITE = 'https://beta.cno.to';
var CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
var REQUEST_TIMEOUT_MS = 8000;
var SUBTITLE_TIMEOUT_MS = 4000;   // the site fetches a subtitle file on first request and that can take 10-20 s: never hold the streams for it
var CACHE_MS = 5 * 60 * 1000;
var DEBUG = true;
var T0 = Date.now();
var cache = {};

function log() {
  if (DEBUG) console.log.apply(console, ['[Cno +' + (Date.now() - T0) + 'ms]'].concat([].slice.call(arguments)));
}

function settings() {
  return (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
}

// request headers: always a browser-like User-Agent; an optional user-supplied cf_clearance (+ matching UA) for the day Cloudflare
// starts challenging this site. Not needed today.
function siteHeaders() {
  var s = settings();
  var h = { 'User-Agent': (typeof s.user_agent === 'string' && s.user_agent) ? s.user_agent : CHROME_UA };
  if (typeof s.cf_clearance === 'string' && s.cf_clearance) h.Cookie = 'cf_clearance=' + s.cf_clearance;
  return h;
}

function withTimeout(p, ms, what) {
  if (typeof setTimeout !== 'function') return p;
  return new Promise(function (resolve, reject) {
    var t = setTimeout(function () { reject(new Error('timeout ' + what)); }, ms);
    p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
  });
}

// one GET; resolves { status, url, text } and never rejects (status 0 on a network error or timeout)
function get(path, what, timeoutMs) {
  var url = path.indexOf('http') === 0 ? path : SITE + path;
  return withTimeout(fetch(url, { headers: siteHeaders() }), timeoutMs || REQUEST_TIMEOUT_MS, what || path)
    .then(function (r) {
      return r.text().then(function (text) { return { status: r.status, url: r.url || url, text: text }; });
    })
    .catch(function (e) {
      log('fetch failed', what || path, String(e && e.message || e));
      return { status: 0, url: url, text: '' };
    });
}

function isId(v) { return /^[1-9]\d{0,9}$/.test(String(v)); }
function isNum(v) { return /^\d{1,4}$/.test(String(v)); }
function pad4(n) { var s = String(n); while (s.length < 4) s = '0' + s; return s; }

// the 4K / 1080p / ... tier a RESOLUTION belongs to; widescreen "scope" frames (3840x1600, 2592x1080) go by width
function tierOf(w, h) {
  if (w >= 3200) return 2160;
  if (w >= 1800) return 1080;
  if (w >= 1200) return 720;
  if (w >= 800) return 480;
  if (w > 0) return 360;
  if (h >= 2000) return 2160;
  if (h >= 1000) return 1080;
  if (h >= 700) return 720;
  if (h >= 460) return 480;
  return 360;
}

// "#EXT-X-STREAM-INF ..." + url line pairs -> [{ tier, w, h, bw, path }], best first
function parseVariants(text) {
  var lines = String(text).split(/\r?\n/), out = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    var next = lines[i + 1] ? lines[i + 1].replace(/^\s+|\s+$/g, '') : '';
    if (!next || next.charAt(0) === '#') continue;
    var res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
    var bw = /[^-]BANDWIDTH=(\d+)/.exec(lines[i]);
    var w = res ? parseInt(res[1], 10) : 0, h = res ? parseInt(res[2], 10) : 0;
    out.push({ tier: tierOf(w, h), w: w, h: h, bw: bw ? parseInt(bw[1], 10) : 0, path: next });
  }
  out.sort(function (a, b) { return (b.tier - a.tier) || (b.bw - a.bw); });
  return out;
}

// media names of #EXT-X-MEDIA:TYPE=<type> (library masters only)
function parseMedia(text, type) {
  var lines = String(text).split(/\r?\n/), out = [];
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-MEDIA:TYPE=' + type) !== 0) continue;
    var name = /NAME="([^"]*)"/.exec(lines[i]);
    var forced = /FORCED=YES/.test(lines[i]);
    if (name && !forced) out.push(name[1].replace(/\s*\[[^\]]*\]\s*$/, ''));
  }
  return out;
}

function mbps(bw) { return bw ? (Math.round(bw / 100000) / 10) + ' Mbps' : ''; }

function subtitleFor(subPath) {
  // /screen/subs/.../en.vtt exists only when the site has an English file; check it so the player never gets a dead link
  return get(subPath, 'subtitle', SUBTITLE_TIMEOUT_MS).then(function (r) {
    if (r.status === 200 && /^\s*WEBVTT/.test(r.text)) {
      return [{ url: SITE + subPath, lang: 'en', label: 'English' }];
    }
    return [];
  });
}

function playHeaders() {
  var h = siteHeaders();
  return { 'User-Agent': h['User-Agent'], Cookie: h.Cookie };
}
function cleanHeaders(h) {
  var o = {};
  for (var k in h) if (h[k]) o[k] = h[k];
  return o;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Server 21 (the site's own HLS, movies + non-anime TV)
// ---------------------------------------------------------------------------------------------------------------------------
function ownStreams(key, masterText, subs) {
  var variants = parseVariants(masterText);
  var base = 'Cno';
  var headers = cleanHeaders(playHeaders());
  var out = [];
  var top = variants[0];
  out.push({
    name: base + ' - Auto (Best)',
    title: 'Auto (Best) - adaptive, up to ' + top.tier + 'p' + (top.bw ? ' - ' + mbps(top.bw) : '') + ' - Server 21',
    url: SITE + '/screen/master/' + key + '/index.m3u8',
    quality: top.tier + 'p',
    size: '',
    headers: headers,
    subtitles: subs
  });
  if (settings().per_quality !== false) {
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i];
      out.push({
        name: base + ' - ' + v.tier + 'p',
        title: v.tier + 'p - ' + v.w + 'x' + v.h + (v.bw ? ' - ' + mbps(v.bw) : '') + ' - Server 21',
        url: SITE + v.path,
        quality: v.tier + 'p',
        size: '',
        headers: headers,
        subtitles: subs
      });
    }
  }
  return out;
}

function ownLookup(key) {
  return get('/screen/master/' + key, 'master ' + key).then(function (m) {
    if (m.status === 200 && /^#EXTM3U/.test(m.text.replace(/^\s+/, '')) && /\/screen\/pl\//.test(m.text)) return m.text;
    if (m.status === 200) log('master is not a Server 21 master (anime-style), ' + key);
    else log('master ' + m.status + ' ' + key);
    return null;
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// anime library (/hls/<folder>/E<nnnn>/master.m3u8)
// ---------------------------------------------------------------------------------------------------------------------------
function animeStreams(tmdbId, season, episode) {
  return get('/screen-api/tv/' + tmdbId + '/episode/' + season + '/' + episode + '?site=dexter', 'episode sources').then(function (r) {
    if (r.status !== 200) return [];
    var m = /ani\.pm\/embed\/ani\/(\d+)\/(\d+)\//.exec(r.text);
    if (!m) { log('no anime source for', tmdbId, season, episode); return []; }
    var aid = m[1], ep = parseInt(m[2], 10);
    // /anime/<id> redirects to /anime/<slug>-<id>; the library folder is <id>-<slug> for most titles
    return get('/anime/' + aid, 'anime slug').then(function (p) {
      var s = new RegExp('/anime/([a-z0-9-]+)-' + aid + '(?:[/?#]|$)').exec(p.url || '');
      if (!s) { log('no slug for anilist', aid); return []; }
      var folder = aid + '-' + s[1];
      var path = '/hls/' + folder + '/E' + pad4(ep) + '/master.m3u8';
      return get(path, 'library master').then(function (mm) {
        if (mm.status !== 200 || !/^#EXTM3U/.test(mm.text.replace(/^\s+/, ''))) { log('library master', mm.status, folder, ep); return []; }
        var variants = parseVariants(mm.text);
        if (!variants.length) return [];
        var top = variants[0];
        var audio = parseMedia(mm.text, 'AUDIO'), subs = parseMedia(mm.text, 'SUBTITLES');
        var uniq = function (a) { var o = []; for (var i = 0; i < a.length; i++) if (o.indexOf(a[i]) < 0) o.push(a[i]); return o; };
        audio = uniq(audio); subs = uniq(subs);
        var label = 'Audio: ' + (audio.slice(0, 3).join(', ') || 'default') + (audio.length > 3 ? ' +' + (audio.length - 3) : '') +
          (subs.length ? ' - ' + subs.length + ' subtitle track' + (subs.length > 1 ? 's' : '') + ' in the player' : '');
        return [{
          name: 'Cno - Auto (Best) - Library',
          title: 'Library HLS - up to ' + top.tier + 'p - ' + label,
          url: SITE + path,
          quality: top.tier + 'p',
          size: '',
          headers: cleanHeaders(playHeaders()),
          subtitles: []
        }];
      });
    });
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
function fetchStreams(tmdbId, mediaType, season, episode) {
  var isTv = mediaType === 'tv';
  var s = isTv ? parseInt(season, 10) : 0, e = isTv ? parseInt(episode, 10) : 0;
  var key = isTv ? 'tv/' + tmdbId + '/' + s + '/' + e : 'movie/' + tmdbId;
  var subPath = '/screen/subs/' + key + '/en.vtt';
  return Promise.all([ownLookup(key), subtitleFor(subPath)]).then(function (res) {
    if (res[0]) {
      log('server 21 ok', key);
      return ownStreams(key, res[0], res[1]);
    }
    if (isTv) return animeStreams(tmdbId, s, e);
    return [];
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  T0 = Date.now();
  try {
    if (!isId(tmdbId) || (mediaType !== 'movie' && mediaType !== 'tv')) return Promise.resolve([]);
    if (mediaType === 'tv' && (!isNum(season) || !isNum(episode))) return Promise.resolve([]);
    var ck = mediaType + '|' + tmdbId + '|' + (mediaType === 'tv' ? season + '|' + episode : '') + '|' + (settings().per_quality !== false);
    var hit = cache[ck];
    if (hit && Date.now() - hit.t < CACHE_MS) { log('cache hit', ck); return Promise.resolve(hit.v); }
    log('getStreams', tmdbId, mediaType, season, episode);
    return fetchStreams(String(tmdbId), mediaType, season, episode).then(function (out) {
      log('returning', out.length, 'stream(s)');
      if (out.length) cache[ck] = { t: Date.now(), v: out };
      return out;
    }).catch(function (e) {
      log('error', String(e && e.message || e));
      return [];
    });
  } catch (e) {
    log('error', String(e && e.message || e));
    return Promise.resolve([]);
  }
}

function onSettings() {
  return [
    { type: 'info', label: 'Works without any setup. The options below are only for tuning.' },
    { type: 'toggle', key: 'per_quality', label: 'List every quality as its own entry', description: 'Auto (Best) is always listed first; this adds 2160p / 1080p / 720p / 480p entries for movies and TV.', defaultValue: true },
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
