// MoanaTV (moanatv.lfmx.app) provider for Nuvio. Promise chains, plain ES5. No Buffer, TextEncoder, crypto, WebAssembly, setTimeout needed.
//
// How the site plays something (reverse-engineered from its Watch/useStreamSources bundles, see README):
//   1. GET https://stream.lfmx.app/api/v/l?t=movie|tv&i=<TMDB id>&se=<season>&ep=<episode>
//        -> { servers: { <serverCode>: <one-shot token> }, caps, order, down }
//   2. GET https://stream.lfmx.app/api/v/<token>            (one request per server)
//        -> { sources: [{ url, alternates: [...], quality, type: hls|mp4 }], subtitles: [{ url, language, lang }], audio?, skip?, anime? }
//      url is either a direct CDN playlist, a proxied playlist on relay.lfmx.app / stream.lfmx.app, or (server "Armin")
//      an HTML embed page on kaembed.net that contains the signed .m3u8.
//   Both API hosts answer 403 unless the request carries Origin or Referer = the site. Proxied playlists and subtitles need the
//   same header on every request, so the stream objects carry it. Direct CDN playlists need no header at all.
//   TMDB ids are accepted as they are, no title lookup (the "ti" title parameter the site sends is not needed: lists were identical without it).
// Third-party extra the site itself also uses: scrapper.rivestream.app provider "citadel" = "Levi (Multilang)". Its "vanguard" provider
// ("Floch 4K") answered with an error after 12-15 s for every title tested, so it is not queried. Citadel mixes in Hindi / Tamil / Kannada
// dubs ("720p | Hindi"); only the English entries are kept.
//
// Output: "Auto (Best)" first, then every server that really answered with a playable playlist or file.

var SITE = 'https://moanatv.lfmx.app';
var API = 'https://stream.lfmx.app/api/v';
var RIVE = 'https://scrapper.rivestream.app/api/provider';
var BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
var SITE_HEADERS = { 'Origin': SITE, 'Referer': SITE + '/' };
var CACHE_MS = 5 * 60 * 1000;
var MAX_CANDIDATES = 2;          // direct url + one alternate; the third and fourth alternates of a source are a slow second upstream
var DEBUG = true;
var T0 = Date.now();

function log() { if (DEBUG) console.log.apply(console, ['[MoanaTV +' + (Date.now() - T0) + 'ms]'].concat([].slice.call(arguments))); }

// Server table taken from the site's bundle. skip = listed but not shippable (reason in README).
var SERVERS = {
  'fDpLwL': { name: 'Mikasa', rank: 90 },
  // Hange and Zeke sit on the relay, whose upstream cuts connections mid-segment now and then (seen in 4 of 18 matrix cases). They are
  // listed, but never picked as "Auto (Best)" while a steadier server has a stream.
  'i7My6U': { name: 'Hange 4K', rank: 95, noAuto: true },
  '0ROiNP': { name: 'Zeke', rank: 70, noAuto: true },
  'tK4wQe': { name: 'Armin', rank: 80 },
  'wmbOJV': { name: 'Erwin', rank: 60 },
  'KNQkyN': { name: 'Reiner', rank: 50 },
  'drgYQh': { name: 'Jean', rank: 40 },
  'ufebLW': { name: 'Historia', rank: 40 },
  'Xhya9t': { name: 'Bertholdt', rank: 40 },
  '2Ap3RH': { name: 'Connie', rank: 40 },
  'XbNlZQ': { name: 'Sasha', rank: 40 },
  'L2XXTD': { name: 'Jotaro (Sub)', rank: 85, anime: true },
  'vyE84U': { name: 'Jotaro (Dub)', rank: 84, anime: true },
  // anigato.lol proxies (need the site's Origin). Gyro's segments are served as fake PNG images from a slow image CDN (10+ s for
  // the first one), so it is skipped. Jonathan and Jodio serve plain transport streams.
  'oG0TBO': { name: 'Gyro (Sub)', skip: true },
  'cIAjgV': { name: 'Gyro (Dub)', skip: true },
  'HlJsop': { name: 'Jonathan (Sub)', rank: 65, anime: true },
  'SnrcZH': { name: 'Jonathan (Dub)', rank: 64, anime: true },
  '8n07rh': { name: 'Jodio (Sub)', rank: 62, anime: true },
  '2RAHBL': { name: 'Jodio (Dub)', rank: 61, anime: true }
};

function settings() {
  var s = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
  return {
    subtitles: s.subtitles !== false,
    rivestream: s.rivestream !== false,
    otherLangs: s.other_langs !== false,
    showUnavailable: s.show_unavailable === true
  };
}

function isSiteHost(url) {
  var m = /^https?:\/\/([^\/?#:]+)/i.exec(url || '');
  return !!m && /(^|\.)(lfmx\.app|anigato\.lol)$/i.test(m[1]);   // hosts that check for the site's Origin / Referer
}
function headersFor(url) { return isSiteHost(url) ? { 'Origin': SITE_HEADERS.Origin, 'Referer': SITE_HEADERS.Referer } : {}; }

function fetchText(url, headers) {
  return fetch(url, { headers: headers || {} }).then(function (r) {
    return r.text().then(function (t) { return { ok: r.ok, status: r.status, text: t || '', url: r.url || url }; });
  });
}
function fetchJson(url, headers) {
  return fetchText(url, headers).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return JSON.parse(r.text);
  });
}

// Quality label from the widest variant of a master playlist. Width, not height, because scope films are 3840x1600 / 1920x800.
function labelFromResolution(w, h) {
  if (w >= 3400 || h >= 2000) return '2160p';
  if (w >= 2400 || h >= 1400) return '1440p';
  if (w >= 1700 || h >= 1000) return '1080p';
  if (w >= 1100 || h >= 700) return '720p';
  if (w >= 800 || h >= 460) return '480p';
  return '360p';
}
function labelFromText(q) {
  var m = /(\d{3,4})\s*p/i.exec(q || '');
  return m ? m[1] + 'p' : '';
}
function heightOf(label) { var m = /^(\d+)p$/.exec(label || ''); return m ? parseInt(m[1], 10) : 0; }

function absUrl(rel, base) {
  try { return new URL(rel, base).toString(); } catch (e) { return null; }
}
function segmentUris(text) {
  var out = [], lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) { var l = lines[i].trim(); if (l && l.charAt(0) !== '#') out.push(l); }
  return out;
}
function firstUri(text) {
  var lines = text.split(/\r?\n/);
  for (var i = 0; i < lines.length; i++) { var l = lines[i].trim(); if (l && l.charAt(0) !== '#') return l; }
  return null;
}

// Real first-segment check. The relay hands out playlists even when its upstream is dead (HTTP 502 on the segment), so a playlist
// that parses is not enough. No Range header on purpose: a 4 KiB partial answer was once served back (as 206 / 4096 bytes) to a later plain
// request for the same anigato segment, which would break playback. The runtime caps response bodies at 1 MiB anyway.
function probeSegment(url, headers) {
  return fetch(url, { headers: headers }).then(function (r) {
    // 206 to a request without Range means the edge cache answers with a stored partial (4096 of ~114000 bytes was seen): unplayable.
    if (r.status !== 200) return { ok: false, why: 'segment status ' + r.status };
    var cl = parseInt(r.headers && r.headers.get ? r.headers.get('content-length') : '', 10);
    return r.arrayBuffer().then(function (buf) {
      var b = new Uint8Array(buf);
      // The relay serves segment 0 from its cache but cuts later ones after 32-64 KB (declared length not reached). The runtime caps bodies at 1 MiB.
      if (cl > 0 && b.length < Math.min(cl, 1048576)) return { ok: false, why: 'segment cut (' + b.length + ' of ' + cl + ' bytes)' };
      if (b.length < 188) return { ok: false, why: 'segment too small (' + b.length + ')' };
      if (b[0] === 0x3c || b[0] === 0x7b) return { ok: false, why: 'segment is text' };        // "<html" or "{json"
      if (b[0] === 0x89 && b[1] === 0x50) return { ok: false, why: 'png-wrapped segment' };      // fake PNG header, slow image CDN
      return { ok: true };
    });
  });
}

// Headers for a follow-up request: whatever the master needed, plus the site's Origin/Referer on its own hosts.
function mergedHeaders(url, base) {
  var h = headersFor(url), k;
  for (k in base) h[k] = base[k];
  return h;
}

// Probe the first segment and the third one (or the last, in a short playlist), both must come through whole.
function probeSegments(uris, base, headers) {
  if (!uris.length) return Promise.resolve({ ok: false, why: 'variant has no segments' });
  var picks = [uris[0]];
  if (uris.length > 1) picks.push(uris[Math.min(2, uris.length - 1)]);
  return Promise.all(picks.map(function (u) {
    var su = absUrl(u, base);
    return su ? probeSegment(su, mergedHeaders(su, headers)) : { ok: false, why: 'bad segment url' };
  })).then(function (rs) {
    for (var i = 0; i < rs.length; i++) if (!rs[i].ok) return rs[i];
    return { ok: true };
  });
}

// Walk master -> best variant -> first and third segment. Returns { ok, quality, why } and never rejects.
function probeHls(url, headers) {
  return fetchText(url, headers).then(function (r) {
    var t = r.text.replace(/^\uFEFF/, '').trim();
    if (!r.ok || t.indexOf('#EXTM3U') !== 0) return { ok: false, why: 'playlist status ' + r.status };
    var lines = t.split(/\r?\n/), best = -1, bw = 0, bh = 0, bestUri = null, firstVariant = null, i, m;
    for (i = 0; i < lines.length; i++) {
      if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
      var uri = lines[i + 1] && lines[i + 1].charAt(0) !== '#' ? lines[i + 1].trim() : null;
      if (!uri) continue;
      if (!firstVariant) firstVariant = uri;
      m = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]);
      var w = m ? parseInt(m[1], 10) : 0, h = m ? parseInt(m[2], 10) : 0;
      if (w * h > best) { best = w * h; bw = w; bh = h; bestUri = uri; }
    }
    var quality = bw ? labelFromResolution(bw, bh) : '';
    var variant = bestUri || firstVariant;
    var base = r.url || url;
    var seg;
    if (variant) {
      var vu = absUrl(variant, base);
      if (!vu) return { ok: false, why: 'bad variant url' };
      seg = fetchText(vu, mergedHeaders(vu, headers)).then(function (v) {
        var vt = v.text.replace(/^\uFEFF/, '').trim();
        if (!v.ok || vt.indexOf('#EXTM3U') !== 0) return { ok: false, why: 'variant status ' + v.status };
        return probeSegments(segmentUris(vt), v.url || vu, headers);
      });
    } else {
      seg = /#EXTINF:/.test(t) ? probeSegments(segmentUris(t), base, headers) : Promise.resolve({ ok: false, why: 'empty playlist' });
    }
    return seg.then(function (p) { return { ok: p.ok, why: p.why, quality: quality }; });
  }).then(null, function (e) { return { ok: false, why: String(e && e.message || e) }; });
}

function probeMp4(url, headers) {
  var h = { 'Range': 'bytes=0-1' };
  for (var k in headers) h[k] = headers[k];
  return fetch(url, { headers: h }).then(function (r) { return { ok: r.status === 200 || r.status === 206, why: 'status ' + r.status }; })
    .then(null, function (e) { return { ok: false, why: String(e && e.message || e) }; });
}

// Try candidate URLs in order (direct host first, proxied mirrors after) and keep the first that really serves a playlist.
function firstGoodHls(urls, i, first) {
  if (i >= urls.length) return Promise.resolve(first ? { dead: true, url: first.url, headers: first.headers, quality: first.quality } : null);
  var u = urls[i], hd = headersFor(u);
  return probeHls(u, hd).then(function (p) {
    if (p.ok) return { url: u, headers: hd, quality: p.quality };
    log('dead candidate', hostOf(u), p.why);
    return firstGoodHls(urls, i + 1, first || { url: u, headers: hd, quality: p.quality });
  });
}
function hostOf(u) { var m = /^https?:\/\/([^\/?#]+)/i.exec(u || ''); return m ? m[1] : '?'; }

function candidates(src) {
  var list = [src.url].concat(src.alternates || []).filter(function (u) { return typeof u === 'string' && /^https?:\/\//i.test(u); });
  // Direct (non lfmx) hosts need no header, so they go before the proxied copies.
  var direct = list.filter(function (u) { return !isSiteHost(u); }), proxied = list.filter(isSiteHost);
  return direct.concat(proxied).slice(0, MAX_CANDIDATES + (direct.length ? 1 : 0));
}

// Server "Armin": the source is an HTML page whose JS holds the signed master playlist.
function looksLikeEmbed(url) { return /\/embed-[a-z0-9]+\.html/i.test(url || ''); }
function extractM3u8(html) {
  var m = /https?:\/\/[^"'\s\\]+\.m3u8[^"'\s\\]*/.exec(html || '');
  return m ? m[0].replace(/\\u0026/g, '&').replace(/&amp;/g, '&') : null;
}

function englishSubtitles(list) {
  var out = [], i, s, plain = [], sdh = [];
  for (i = 0; i < (list || []).length; i++) {
    s = list[i];
    if (!s || typeof s.url !== 'string' || !/^https?:\/\//i.test(s.url)) continue;
    // qqqcdn.cloud (Armin's subtitle host) sits behind a Cloudflare challenge and cannot be fetched by a player.
    if (/qqqcdn\.cloud/i.test(s.url)) continue;
    if (!(String(s.lang || '').toLowerCase() === 'en' || /^english/i.test(s.language || ''))) continue;
    (/sdh|hearing|cc/i.test(s.language || '') ? sdh : plain).push(s);
  }
  plain.concat(sdh).slice(0, 2).forEach(function (x) {
    var o = { url: x.url, lang: 'en', language: 'English', label: x.language || 'English' };
    var hd = headersFor(x.url);
    if (hd.Origin) o.headers = hd;
    out.push(o);
  });
  return out;
}

// One server -> array of playable entries ({ name, quality, url, headers, subtitles, rank }). Never rejects.
function resolveServer(code, token, skipProbe) {
  var info = SERVERS[code] || { name: 'Server ' + code, rank: 30 };
  var showDead = settings().showUnavailable;
  return fetchJson(API + '/' + token, SITE_HEADERS).then(function (j) {
    var sources = (j && j.sources || []).filter(function (s) { return s && s.url; });
    if (!sources.length) return [];
    var subs = settings().subtitles ? englishSubtitles(j.subtitles) : [];
    return Promise.all(sources.slice(0, 4).map(function (src) {
      var type = String(src.type || '').toLowerCase();
      if (type === 'mp4') {
        var u = candidates(src)[0];
        if (!u) return null;
        var hd = headersFor(u);
        var q4 = labelFromText(src.quality) || '';
        if (skipProbe) return { name: info.name, quality: q4, url: u, headers: hd, subtitles: subs, rank: info.rank, format: 'mp4', noAuto: true, dead: true };
        return probeMp4(u, hd).then(function (p) {
          if (!p.ok) {
            log(info.name, 'mp4 dead', p.why);
            return showDead ? { name: info.name, quality: q4, url: u, headers: hd, subtitles: subs, rank: info.rank, format: 'mp4', noAuto: true, dead: true } : null;
          }
          return { name: info.name, quality: q4, url: u, headers: hd, subtitles: subs, rank: info.rank, format: 'mp4', noAuto: !!info.noAuto };
        });
      }
      var urls = candidates(src);
      var start = looksLikeEmbed(src.url)
        ? fetchText(src.url, {}).then(function (r) { var m = extractM3u8(r.text); return m ? [m] : []; })
        : Promise.resolve(urls);
      return start.then(function (us) {
        if (skipProbe) return us.length ? { dead: true, url: us[0], headers: headersFor(us[0]), quality: '' } : null;
        return firstGoodHls(us, 0);
      }).then(function (g) {
        if (!g || (g.dead && !showDead && !skipProbe)) return null;
        return { name: info.name, quality: g.quality || labelFromText(src.quality), url: g.url, headers: g.headers, subtitles: subs, rank: info.rank, format: 'hls', noAuto: g.dead ? true : !!info.noAuto, dead: !!g.dead };
      });
    })).then(function (rows) { return rows.filter(Boolean); });
  }).then(null, function (e) {
    log(info.name, 'failed:', String(e && e.message || e));
    return [];
  });
}

function unwrapProxy(url) {
  try {
    var m = /^https:\/\/proxy\.valhallastream\.com\/[^?]*\?(.*)$/.exec(url || '');
    if (!m) return url;
    var q = new URLSearchParams(m[1]);
    return q.get('url') || q.get('url1') || url;
  } catch (e) { return url; }
}

// Rivestream (third party, the site calls it too). provider: 'citadel'.
function resolveRive(provider, label, rank, type, id, season, episode) {
  var u = RIVE + '?provider=' + provider + '&id=' + encodeURIComponent(id);
  if (type === 'tv') u += '&season=' + season + '&episode=' + episode;
  return fetchJson(u, {}).then(function (j) {
    var d = j && j.data, srcs = d && d.sources || [];
    if (!srcs.length) return [];
    var subs = [];
    if (settings().subtitles) {
      (d.captions || []).forEach(function (c) {
        if (subs.length < 2 && c && c.file && /^english/i.test(c.language || c.label || '')) {
          var f = unwrapProxy(c.file);
          if (/^https?:\/\//i.test(f)) subs.push({ url: f, lang: 'en', language: 'English', label: c.label || 'English' });
        }
      });
    }
    return Promise.all(srcs.slice(0, 4).map(function (s) {
      var url = unwrapProxy(s.url);
      if (!/^https?:\/\//i.test(url)) return null;
      var hd = headersFor(url);
      var isHls = s.format === 'hls' || /\.m3u8/.test(url);
      var q = labelFromText(s.quality);
      var lm = /\|\s*([^|]+)$/.exec(s.quality || '');
      var lang = lm ? lm[1].trim() : 'English';
      var english = /^english$/i.test(lang);
      if (!english && !settings().otherLangs) return null;
      var probe = isHls ? probeHls(url, hd) : probeMp4(url, hd);
      return probe.then(function (p) {
        if (!p.ok) { log(label, 'dead', p.why); return null; }
        return { name: label, quality: q || p.quality || '', url: url, headers: hd, subtitles: subs, rank: rank, format: isHls ? 'hls' : 'mp4', language: lang, noAuto: !english };
      });
    })).then(function (rows) {
      // Citadel lists several dubs (Hindi, Tamil, ...): keep every English entry, but only the best quality of each other language.
      var seen = {};
      return rows.filter(Boolean).sort(function (a, b) { return heightOf(b.quality) - heightOf(a.quality); }).filter(function (e) {
        if (!e.noAuto) return true;
        if (seen[e.language]) return false;
        seen[e.language] = true;
        return true;
      });
    });
  }).then(null, function (e) { log(label, 'failed:', String(e && e.message || e)); return []; });
}

// Eren: the site's default server, not in the API list (the site's JS asks cno.to itself). cno.to answers 403 unless the User-Agent looks like a
// browser or ExoPlayer ("Mozilla/5.0 ... AppleWebKit/537.36" without a Chrome token, which is what the plugin runtime sends by default, gets 403),
// and also 403s when Origin is the site. So: Chrome User-Agent, no Origin. The same header goes on the stream so the player's own User-Agent
// does not break the playlist. Variants and segments live on a CDN (v.lumenbox.top, fMP4 behind .png/.webp names, content-type video/iso.segment).
function resolveEren(type, id, season, episode) {
  var u = 'https://cno.to/api/s/21/' + (type === 'tv' ? 'tv/' + id + '/' + season + '/' + episode : 'movie/' + id) + '?v=3';
  var hd = { 'User-Agent': BROWSER_UA };
  return probeHls(u, hd).then(function (p) {
    if (!p.ok) { log('Eren', 'no stream:', p.why); return []; }
    return [{ name: 'Eren', quality: p.quality, url: u, headers: hd, subtitles: [], rank: 100, format: 'hls' }];
  });
}

// Highest quality first, then server preference.
function sortEntries(list) {
  return list.slice().sort(function (a, b) {
    if (!!a.dead !== !!b.dead) return a.dead ? 1 : -1;
    var d = heightOf(b.quality) - heightOf(a.quality);
    return d !== 0 ? d : b.rank - a.rank;
  });
}

function toStream(e, auto) {
  var q = e.quality || '';
  var lang = e.language && !/^english$/i.test(e.language) ? ' [' + e.language + ']' : '';
  var mark = e.dead ? ' (unverified, may not play)' : '';
  return {
    name: auto ? 'MoanaTV - Auto (Best)' : 'MoanaTV - ' + e.name + lang + (q ? ' ' + q : '') + mark,
    title: e.name + lang + (q ? ' ' + q : '') + ' ' + e.format.toUpperCase() + mark,
    url: e.url,
    quality: q || 'Auto',
    headers: e.headers || {},
    subtitles: e.subtitles || []
  };
}

var cache = {};

function run(id, type, season, episode) {
  var cfg = settings();
  var list = API + '/l?t=' + type + '&i=' + id + '&se=' + season + '&ep=' + episode;
  var site = fetchJson(list, SITE_HEADERS).then(function (j) {
    var servers = j && j.servers || {}, jobs = [], code;
    for (code in servers) {
      if (!servers.hasOwnProperty(code)) continue;
      var skip = !!(SERVERS[code] && SERVERS[code].skip);
      if (skip && !cfg.showUnavailable) continue;
      jobs.push(resolveServer(code, servers[code], skip));
    }
    log('server list', jobs.length, 'tokens');
    return Promise.all(jobs).then(function (rows) { return [].concat.apply([], rows); });
  }).then(null, function (e) { log('server list failed:', String(e && e.message || e)); return []; });
  var rive = cfg.rivestream
    ? resolveRive('citadel', 'Levi (Citadel)', 60, type, id, season, episode)
    : Promise.resolve([]);
  var eren = resolveEren(type, id, season, episode);
  return Promise.all([site, rive, eren]).then(function (res) {
    var all = sortEntries(res[0].concat(res[1], res[2]));
    if (!all.length) return [];
    var live = all.filter(function (e) { return !e.dead; }), out = [], pick = null, k;
    if (live.length) {
      pick = live[0];
      for (k = 0; k < live.length; k++) { if (!live[k].noAuto) { pick = live[k]; break; } }
      out.push(toStream(pick, true));
    }
    all.forEach(function (e) { out.push(toStream(e, false)); });
    log('returning', out.length, 'streams; auto', pick ? pick.name + ' ' + pick.quality : 'none (only unverified servers)');
    return out;
  });
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var id = String(tmdbId == null ? '' : tmdbId).trim();
    if (!/^\d{1,10}$/.test(id)) return Promise.resolve([]);
    var type = mediaType === 'tv' ? 'tv' : 'movie';
    var s = 1, e = 1;
    if (type === 'tv') {
      s = parseInt(season, 10); e = parseInt(episode, 10);
      if (isNaN(s) || s < 0) s = 1;
      if (isNaN(e) || e < 0) e = 1;
    }
    var key = type + ':' + id + ':' + s + ':' + e + ':' + (settings().subtitles ? 1 : 0) + (settings().rivestream ? 1 : 0) + (settings().otherLangs ? 1 : 0) + (settings().showUnavailable ? 1 : 0);
    var hit = cache[key];
    if (hit && Date.now() - hit.at < CACHE_MS) return Promise.resolve(hit.out);
    return run(id, type, s, e).then(function (out) {
      if (out.length) cache[key] = { at: Date.now(), out: out };
      return out;
    }).then(null, function (err) {
      log('getStreams failed:', String(err && err.message || err));
      return [];
    });
  } catch (err) {
    log('getStreams crashed:', String(err && err.message || err));
    return Promise.resolve([]);
  }
}

function onSettings() {
  return [
    { type: 'header', label: 'MoanaTV' },
    { type: 'info', label: 'No account, cookie or key needed. Servers are named after the site\'s own server list.' },
    { type: 'toggle', key: 'subtitles', label: 'English subtitles', description: 'Attach up to two English subtitles when a server provides them.', defaultValue: true },
    { type: 'toggle', key: 'rivestream', label: 'Third-party server (Levi)', description: 'Also ask scrapper.rivestream.app, which the site itself uses for the Levi server.', defaultValue: true },
    { type: 'toggle', key: 'other_langs', label: 'Other-language audio (Levi)', description: 'List the Hindi, Tamil and other dubs Levi offers as extra entries (never chosen as Auto).', defaultValue: true },
    { type: 'toggle', key: 'show_unavailable', label: 'Show unavailable servers', description: 'Also list servers that gave a link but failed the playback check (for example Hange 4K and Zeke, whose relay cuts segments) at the end, marked unverified. They may stall. Servers the site itself has no link for cannot be listed.', defaultValue: false }
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
