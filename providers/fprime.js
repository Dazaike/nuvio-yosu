// fprime (fprime.at) local scraper for Nuvio.
// fprime.at is a Vite/React shell (TMDB ids in its routes). Its player asks two backends for a stream and this plugin asks them directly:
//   Aurora: storage.insidethisplaceiswarm.cc/content/<movie/ID | tv/ID/S/E>, signed with a per-session HMAC (v2 handshake), up to 2160p
//   Astra : serverone.insidethisplaceiswarm.cc/astra?tmdbId=...  -> AES-256-GCM sealed URL -> stream.hls.lol HLS
// Both HLS URLs need a Referer of the site. See README.md for the chain. Runs in QuickJS: no Buffer / TextEncoder / crypto.subtle /
// WebAssembly / setTimeout / crypto-js (the crypto is plain JS below). Plain ES5 promise chains. Never throws or rejects.

var FP_TAG = '[fprime]';
var FP_ORIGIN = 'https://fprime.at';
var FP_REFERER = 'https://fprime.at/';
var FP_ASTRA_URL = 'https://serverone.insidethisplaceiswarm.cc/astra';
var FP_STORE = 'https://storage.insidethisplaceiswarm.cc';
var FP_SUBS_URL = 'https://subs.amnestyinternational.dev/subs';
var FP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
// Build constants of the site's public player bundle (re-extract with tools/extract-constants.js when the site rotates them).
var FP_ASTRA_KEY = 'cc668a8304b57864709efdfc0051a619e146c0c8b486f190a06d1c1cf96af698';
var FP_SEED = '9ffe87cc9d08c07d06514dda26178f231461ddd11af17847988e5faccfc61cc7';
var FP_BUDGET_MS = 32000;          // no new hop starts after this (the host kills the whole call at 45 s)
var FP_CACHE_MS = 5 * 60 * 1000;
var FP_CACHE = {};
var FP_SESSION = null;

function fpLog() {
  try { console.log.apply(console, [FP_TAG].concat(Array.prototype.slice.call(arguments))); } catch (e) {}
}
function fpSettings() {
  try {
    var s = (typeof SCRAPER_SETTINGS !== 'undefined' && SCRAPER_SETTINGS) || {};
    return s && typeof s === 'object' ? s : {};
  } catch (e) { return {}; }
}
function fpFlag(key, dflt) {
  var v = fpSettings()[key];
  if (v === undefined || v === null || v === '') return dflt;
  return v === true || v === 'true' || v === 1 || v === '1';
}
function fpMsg(e) { return e && e.message ? e.message : String(e); }
function fpParse(t) { try { return JSON.parse(t); } catch (e) { return null; } }
function fpNow() { return Math.floor(Date.now() / 1000); }
function fpRandHex(n) {
  var s = '';
  while (s.length < n) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

// ---------------------------------------------------------------- http (fetch is a blocking native call on the device: hops add up)
function fpHttp(ctx, url, opts) {
  opts = opts || {};
  if (Date.now() > ctx.deadline) return Promise.reject(new Error('budget'));
  var headers = {};
  var k;
  for (k in (opts.headers || {})) headers[k] = opts.headers[k];
  if (!headers['User-Agent']) headers['User-Agent'] = FP_UA;
  var o = { method: opts.method || 'GET', headers: headers };
  if (opts.body !== undefined) o.body = opts.body;
  ctx.hops++;
  return fetch(url, o).then(function (r) {
    return r.text().then(function (t) { return { status: r.status, text: t }; });
  });
}
function fpSiteHeaders() { return { Referer: FP_REFERER, Origin: FP_ORIGIN }; }

// ---------------------------------------------------------------- crypto (plain JS: SHA-256, HMAC, AES-256-CTR; the plugin runtimes do not agree on what crypto-js offers,
// e.g. the mobile app's CryptoJS has no CTR mode and no WordArray.concat, so nothing here touches crypto-js). Byte arrays are plain arrays of 0..255.
var FP_K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
];
function fpUtf8(str) {
  var out = [], i, c, d;
  for (i = 0; i < str.length; i++) {
    c = str.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < str.length) {
      d = str.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function fpUtf8Decode(b) {
  var s = '', i = 0, c, n, cp;
  while (i < b.length) {
    c = b[i++];
    n = c < 0x80 ? 0 : c < 0xe0 ? 1 : c < 0xf0 ? 2 : 3;
    cp = n === 0 ? c : n === 1 ? c & 31 : n === 2 ? c & 15 : c & 7;
    while (n-- > 0 && i < b.length) cp = (cp << 6) | (b[i++] & 63);
    if (cp >= 0x10000) { cp -= 0x10000; s += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 1023)); }
    else s += String.fromCharCode(cp);
  }
  return s;
}
function fpHexBytes(hex) {
  var out = [], i;
  for (i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.substr(i, 2), 16));
  return out;
}
function fpBytesHex(b) {
  var s = '', i;
  for (i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return s;
}
function fpSha256(bytes) {
  var h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  var len = bytes.length, bitHi = Math.floor(len / 0x20000000), bitLo = (len << 3) >>> 0;
  var m = bytes.slice();
  m.push(0x80);
  while (m.length % 64 !== 56) m.push(0);
  m.push((bitHi >>> 24) & 255, (bitHi >>> 16) & 255, (bitHi >>> 8) & 255, bitHi & 255, (bitLo >>> 24) & 255, (bitLo >>> 16) & 255, (bitLo >>> 8) & 255, bitLo & 255);
  var w = new Array(64), o, i;
  for (o = 0; o < m.length; o += 64) {
    for (i = 0; i < 16; i++) w[i] = ((m[o + i * 4] << 24) | (m[o + i * 4 + 1] << 16) | (m[o + i * 4 + 2] << 8) | m[o + i * 4 + 3]) | 0;
    for (i = 16; i < 64; i++) {
      var x = w[i - 15], y = w[i - 2];
      var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (i = 0; i < 64; i++) {
      var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      var t1 = (hh + S1 + ((e & f) ^ (~e & g)) + FP_K256[i] + w[i]) | 0;
      var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  var out = [];
  for (i = 0; i < 8; i++) out.push((h[i] >>> 24) & 255, (h[i] >>> 16) & 255, (h[i] >>> 8) & 255, h[i] & 255);
  return out;
}
function fpHmac(keyBytes, msgBytes) {
  if (keyBytes.length > 64) keyBytes = fpSha256(keyBytes);
  var ipad = [], opad = [], i, kb;
  for (i = 0; i < 64; i++) { kb = i < keyBytes.length ? keyBytes[i] : 0; ipad.push(kb ^ 0x36); opad.push(kb ^ 0x5c); }
  return fpSha256(opad.concat(fpSha256(ipad.concat(msgBytes))));
}

var FP_SBOX = (function () {
  var s = [], p = 1, q = 1, x, r;
  function rotl(v, n) { return ((v << n) | (v >> (8 - n))) & 255; }
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x11b : 0)) & 255;     // p *= 3
    q = (q ^ (q << 1)) & 255; q = (q ^ (q << 2)) & 255; q = (q ^ (q << 4)) & 255;
    if (q & 0x80) q ^= 0x09;                                // q /= 3
    x = q; for (r = 1; r <= 4; r++) x ^= rotl(q, r);
    s[p] = x ^ 0x63;
  } while (p !== 1);
  s[0] = 0x63;
  return s;
})();
function fpXtime(a) { return ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 255; }
function fpAes256Keys(key) {            // 32-byte key -> 60 round-key words
  var w = [], i, t, rc = 1, p;
  for (i = 0; i < 8; i++) w.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (i = 8; i < 60; i++) {
    t = w[i - 1].slice();
    if (i % 8 === 0) { t = [FP_SBOX[t[1]] ^ rc, FP_SBOX[t[2]], FP_SBOX[t[3]], FP_SBOX[t[0]]]; rc = fpXtime(rc); }
    else if (i % 8 === 4) t = [FP_SBOX[t[0]], FP_SBOX[t[1]], FP_SBOX[t[2]], FP_SBOX[t[3]]];
    p = w[i - 8];
    w.push([p[0] ^ t[0], p[1] ^ t[1], p[2] ^ t[2], p[3] ^ t[3]]);
  }
  return w;
}
function fpAesBlock(w, input) {        // encrypt one 16-byte block
  var s = input.slice(), r, c, i, n, a0, a1, a2, a3;
  function add(round) { for (i = 0; i < 16; i++) s[i] ^= w[round * 4 + (i >> 2)][i & 3]; }
  add(0);
  for (r = 1; r <= 14; r++) {
    for (i = 0; i < 16; i++) s[i] = FP_SBOX[s[i]];
    n = s.slice();                                          // ShiftRows: row r of column c comes from column c + r
    for (c = 0; c < 4; c++) for (i = 0; i < 4; i++) s[4 * c + i] = n[4 * ((c + i) & 3) + i];
    if (r < 14) {
      for (c = 0; c < 4; c++) {
        a0 = s[4 * c]; a1 = s[4 * c + 1]; a2 = s[4 * c + 2]; a3 = s[4 * c + 3];
        s[4 * c] = fpXtime(a0) ^ (fpXtime(a1) ^ a1) ^ a2 ^ a3;
        s[4 * c + 1] = a0 ^ fpXtime(a1) ^ (fpXtime(a2) ^ a2) ^ a3;
        s[4 * c + 2] = a0 ^ a1 ^ fpXtime(a2) ^ (fpXtime(a3) ^ a3);
        s[4 * c + 3] = (fpXtime(a0) ^ a0) ^ a1 ^ a2 ^ fpXtime(a3);
      }
    }
    add(r);
  }
  return s;
}

// AES-256-GCM decrypt of "iv(12) | ciphertext | tag(16)" (hex) to a string. GCM encrypts with CTR starting at counter 2 (J0 = iv|1); the tag is not
// checked, callers validate the plaintext instead. keyBytes is a 32-byte array.
function fpGcmDecrypt(keyBytes, dataHex) {
  var iv = fpHexBytes(dataHex.substr(0, 24)), ct = fpHexBytes(dataHex.substring(24, dataHex.length - 32));
  var w = fpAes256Keys(keyBytes), out = [], ctr = 2, i, j, ks;
  for (i = 0; i < ct.length; i += 16) {
    ks = fpAesBlock(w, iv.concat([(ctr >>> 24) & 255, (ctr >>> 16) & 255, (ctr >>> 8) & 255, ctr & 255]));
    for (j = 0; j < 16 && i + j < ct.length; j++) out.push(ct[i + j] ^ ks[j]);
    ctr++;
  }
  return fpUtf8Decode(out);
}

// Aurora session (v2 handshake): POST {c,ts,n,s} -> sealed {sid, skey, exp, now}. Reused until a minute before it expires.
function fpGetSession(ctx) {
  if (FP_SESSION && FP_SESSION.exp - (fpNow() + FP_SESSION.dc) > 60) return Promise.resolve(FP_SESSION);
  var ts = fpNow(), n = fpRandHex(16);
  var key0 = fpSha256(fpUtf8('aphrodite.z.v2').concat(fpHexBytes(FP_SEED)));
  var body = JSON.stringify({ c: 'z', ts: ts, n: n, s: fpBytesHex(fpHmac(key0, fpUtf8('v2:z:' + ts + ':' + n))) });
  return fpHttp(ctx, FP_STORE + '/content/index', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: body }).then(function (r) {
    var j = fpParse(r.text);
    if (r.status !== 200 || !j || typeof j.d !== 'string' || j.d.length < 60) throw new Error('session ' + r.status);
    var o = fpParse(fpGcmDecrypt(fpHmac(key0, fpUtf8('aphrodite-seal-v2|' + ts + '|' + n)), j.d));
    if (!o || !o.sid || !o.skey || !o.exp) throw new Error('session payload');
    FP_SESSION = { sid: o.sid, skey: o.skey, exp: o.exp, dc: (o.now || fpNow()) - fpNow() };
    return FP_SESSION;
  });
}
function fpAuthHeaders(sess, path) {
  var ts = fpNow() + sess.dc, n = fpRandHex(16);
  var tag = fpBytesHex(fpHmac(fpHexBytes(sess.skey), fpUtf8('v2:' + sess.sid + ':' + path + ':' + ts + ':' + n)));
  return { 'X-Az-Id': sess.sid, 'X-Az-Ts': String(ts), 'X-Az-Nonce': n, 'X-Az-Tag': tag, Accept: 'application/json' };
}

// ---------------------------------------------------------------- the two servers
function fpAuroraOnce(ctx, path) {
  return fpGetSession(ctx).then(function (sess) {
    return fpHttp(ctx, FP_STORE + path, { headers: fpAuthHeaders(sess, path) });
  }).then(function (r) {
    if (r.status === 401 || r.status === 403) FP_SESSION = null;
    if (r.status === 401 || r.status === 403 || r.status === 429 || r.status >= 500) throw new Error('aurora ' + r.status);
    var j = fpParse(r.text);
    // an unsigned request gets a decoy clip for every id; only a signed answer with found:true is real
    if (!j || j.found !== true || typeof j.url !== 'string' || !/^https?:\/\//.test(j.url)) return null;
    return { name: 'Aurora', url: j.url };
  });
}
// one retry: the session POST and the signed GET fail now and then (5xx, 429, a dropped connection); a stale session is cleared before the retry
function fpAurora(ctx) {
  var path = '/content/' + (ctx.mediaType === 'tv' ? 'tv/' + ctx.tmdbId + '/' + ctx.season + '/' + ctx.episode : 'movie/' + ctx.tmdbId);
  return fpAuroraOnce(ctx, path).catch(function (err) {
    console.log(FP_TAG + ' Aurora retry after: ' + (err && err.message ? err.message : err));
    return fpAuroraOnce(ctx, path);
  });
}

function fpAstra(ctx) {
  var q = 'tmdbId=' + ctx.tmdbId + '&type=' + ctx.mediaType;
  if (ctx.mediaType === 'tv') q += '&seasonId=' + ctx.season + '&episodeId=' + ctx.episode;
  return fpHttp(ctx, FP_ASTRA_URL + '?' + q, { headers: { Accept: 'application/json' } }).then(function (r) {
    var j = fpParse(r.text);
    var src = j && j.sources && j.sources.Astra;
    var u = src && src.url;
    if (typeof u !== 'string' || !u) return null;
    if (u.indexOf('as_') === 0) {
      u = fpGcmDecrypt(fpHexBytes(FP_ASTRA_KEY), u.slice(3));
    }
    return /^https?:\/\//.test(u) ? { name: 'Astra', url: u } : null;
  });
}

// ---------------------------------------------------------------- HLS check
function fpParseMaster(text, base) {
  var lines = text.split(/\r?\n/), vars = [], i;
  for (i = 0; i < lines.length; i++) {
    if (lines[i].indexOf('#EXT-X-STREAM-INF') !== 0) continue;
    var res = /RESOLUTION=(\d+)x(\d+)/.exec(lines[i]), bw = /BANDWIDTH=(\d+)/.exec(lines[i]);
    var u = lines[i + 1] && lines[i + 1].charAt(0) !== '#' ? lines[i + 1].replace(/^\s+|\s+$/g, '') : '';
    if (!u) continue;
    vars.push({ url: new URL(u, base).toString(), w: res ? +res[1] : 0, h: res ? +res[2] : 0, bw: bw ? +bw[1] : 0 });
  }
  if (!vars.length) vars.push({ url: base, w: 0, h: 0, bw: 0, media: true });
  vars.sort(function (a, b) { return (b.w - a.w) || (b.bw - a.bw); });
  return vars;
}
// width buckets of the site's own quality menu
function fpQuality(w, h) {
  if (!w && !h) return 'Unknown';
  var t = [[3400, '2160p'], [2400, '1440p'], [1700, '1080p'], [1150, '720p'], [800, '480p'], [560, '360p'], [400, '240p']], i;
  if (w) { for (i = 0; i < t.length; i++) if (w >= t[i][0]) return t[i][1]; return '144p'; }
  return h >= 2000 ? '2160p' : h >= 1000 ? '1080p' : h >= 700 ? '720p' : h >= 480 ? '480p' : '360p';
}
function fpHeight(q) { var m = /^(\d+)p/.exec(q || ''); return m ? +m[1] : 0; }

// master -> (deep) variant playlist -> first segment. A source that fails any step is dropped (some titles list a playlist whose files 404).
function fpCheck(ctx, src, deep) {
  var H = fpSiteHeaders(), vars;
  return fpHttp(ctx, src.url, { headers: H }).then(function (r) {
    if (r.status !== 200 || r.text.replace(/^\s+/, '').indexOf('#EXTM3U') !== 0) throw new Error('master ' + r.status);
    vars = fpParseMaster(r.text, src.url);
    var best = vars[0];
    src.quality = fpQuality(best.w, best.h);
    if (!deep) return null;
    if (best.media) return r.text;
    // only the head of the variant playlist is needed (Aurora's 4K playlists reach 1 MB); hosts that ignore Range just send all of it
    var hv = fpSiteHeaders();
    hv.Range = 'bytes=0-16383';
    return fpHttp(ctx, best.url, { headers: hv }).then(function (v) {
      if ((v.status !== 200 && v.status !== 206) || v.text.replace(/^\s+/, '').indexOf('#EXTM3U') !== 0) throw new Error('variant ' + v.status);
      return v.text;
    });
  }).then(function (vt) {
    if (!vt) return src;
    var lines = vt.split(/\r?\n/), i, seg = '', range = null, pend = null;
    for (i = 0; i < lines.length; i++) {
      var l = lines[i].replace(/^\s+|\s+$/g, '');
      var br = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/.exec(l);
      if (br) pend = { len: +br[1], off: br[2] ? +br[2] : 0 };
      if (l && l.charAt(0) !== '#') { seg = l; range = pend; break; }
    }
    if (!seg) throw new Error('no segments');
    var h2 = fpSiteHeaders();
    h2.Range = 'bytes=' + (range ? range.off : 0) + '-' + ((range ? range.off : 0) + 31);
    return fpHttp(ctx, new URL(seg, vars[0].url).toString(), { headers: h2 }).then(function (s) {
      if ((s.status !== 200 && s.status !== 206) || !s.text.length || s.text.charAt(0) === '<') throw new Error('segment ' + s.status);
      return src;
    });
  });
}

function fpServer(ctx, resolver, deep) {
  var name = '';
  return resolver(ctx).then(function (src) {
    if (!src) { fpLog('not available on this server'); return null; }
    name = src.name;
    return fpCheck(ctx, src, deep);
  }).then(function (src) {
    if (src) fpLog(src.name + ': ok ' + src.quality);
    return src;
  }).catch(function (e) {
    fpLog((name || 'server') + ' failed: ' + fpMsg(e));
    return null;
  });
}

// ---------------------------------------------------------------- subtitles (natsuki files need Origin/Referer, so they are inlined as data: URIs)
function fpSubtitles(ctx) {
  var q = 'tmdbId=' + ctx.tmdbId + (ctx.mediaType === 'tv' ? '&season=' + ctx.season + '&episode=' + ctx.episode : '');
  var H = fpSiteHeaders();
  H.Accept = 'application/json';
  return fpHttp(ctx, FP_SUBS_URL + '?' + q, { headers: H }).then(function (r) {
    var j = fpParse(r.text), list = (j && j.subtitles) || [];
    var en = list.filter(function (s) { return s && typeof s.url === 'string' && (s.langCode === 'en' || /^english/i.test(s.language || '')); });
    en = en.filter(function (s) { return !s.hearingImpaired; }).concat(en.filter(function (s) { return s.hearingImpaired; }));
    var out = [];
    return en.slice(0, 2).reduce(function (p, s) {
      return p.then(function () {
        if (Date.now() - ctx.t0 > 26000) return;
        return fpHttp(ctx, s.url, { headers: fpSiteHeaders() }).then(function (t) {
          if (t.status !== 200 || t.text.length < 200 || t.text.length > 600000 || t.text.charAt(0) === '<') return;
          out.push({ url: 'data:application/x-subrip;charset=utf-8,' + encodeURIComponent(t.text), lang: 'en', label: out.length ? 'English ' + (out.length + 1) : 'English' });
        }).catch(function () {});
      });
    }, Promise.resolve()).then(function () { return out; });
  }).catch(function (e) { fpLog('subtitles failed: ' + fpMsg(e)); return []; });
}

// ---------------------------------------------------------------- list
function fpToStreams(found, subs) {
  var list = found.slice().sort(function (a, b) { return fpHeight(b.quality) - fpHeight(a.quality); });   // stable: Aurora stays ahead of Astra on ties
  function make(s, name) {
    return { name: name, title: s.name + ' - ' + s.quality + ' - HLS', url: s.url, quality: s.quality, headers: fpSiteHeaders(), subtitles: subs };
  }
  var out = [];
  if (list.length) out.push(make(list[0], 'fprime - Auto (Best)'));
  list.forEach(function (s) { out.push(make(s, 'fprime - ' + s.name)); });
  return out;
}

function fpRun(ctx) {
  var found = [], deep = fpFlag('deep_check', true);
  var jobs = [];
  if (fpFlag('aurora', true)) jobs.push({ name: 'Aurora', fn: fpAurora, max: 40000 });
  if (fpFlag('astra', true)) jobs.push({ name: 'Astra', fn: fpAstra, max: 24000 });
  return jobs.reduce(function (p, job) {
    return p.then(function () {
      if (Date.now() - ctx.t0 > job.max) { fpLog('skip ' + job.name + ' (time)'); return; }
      return fpServer(ctx, job.fn, deep).then(function (s) { if (s) found.push(s); });
    });
  }, Promise.resolve()).then(function () {
    if (!found.length || !fpFlag('subtitles', true)) return [];
    return fpSubtitles(ctx);
  }).then(function (subs) { return fpToStreams(found, subs); });
}

function getStreams(tmdbId, mediaType, season, episode) {
  try {
    var id = String(tmdbId == null ? '' : tmdbId).trim();
    var type = mediaType === 'tv' || mediaType === 'series' ? 'tv' : (mediaType === 'movie' ? 'movie' : '');
    if (!type || !/^\d{1,9}$/.test(id)) return Promise.resolve([]);
    var s = 0, e = 0;
    if (type === 'tv') {
      s = parseInt(season, 10); if (isNaN(s)) s = 1;
      e = parseInt(episode, 10); if (isNaN(e)) e = 1;
      if (e < 1 || s < 0) return Promise.resolve([]);
    }
    var key = type + ':' + id + ':' + s + ':' + e + ':' + JSON.stringify(fpSettings());
    var hit = FP_CACHE[key];
    if (hit && Date.now() - hit.t < FP_CACHE_MS) return Promise.resolve(hit.v);
    var t0 = Date.now();
    var ctx = { tmdbId: id, mediaType: type, season: s, episode: e, t0: t0, deadline: t0 + FP_BUDGET_MS, hops: 0 };
    return fpRun(ctx).then(function (out) {
      fpLog(type + ' ' + id + (type === 'tv' ? ' S' + s + 'E' + e : '') + ': ' + out.length + ' stream(s), ' + ctx.hops + ' hop(s), ' + (Date.now() - t0) + ' ms');
      if (out.length) FP_CACHE[key] = { t: Date.now(), v: out };
      return out;
    }).catch(function (err) {
      fpLog('failed:', fpMsg(err));
      return [];
    });
  } catch (err) {
    return Promise.resolve([]);
  }
}

function onSettings() {
  return [
    { type: 'header', label: 'Servers' },
    { type: 'toggle', key: 'aurora', label: 'Aurora', description: 'The 4K server: up to 2160p, some titles are H.265 at the top rung. Listed first when it has the higher quality.', defaultValue: true },
    { type: 'toggle', key: 'astra', label: 'Astra', description: 'Plain MPEG-TS HLS, usually 720p to 1080p. Also has titles Aurora lacks, but its answer for an unknown title can take several seconds.', defaultValue: true },
    { type: 'header', label: 'Checks' },
    { type: 'toggle', key: 'deep_check', label: 'Check the first segment', description: 'Before listing a server, fetch its variant playlist and the first segment (2 extra requests per server) so titles whose files are missing do not show up as dead links.', defaultValue: true },
    { type: 'toggle', key: 'subtitles', label: 'English subtitles', description: 'Adds up to two English subtitle files (one extra request each).', defaultValue: true },
    { type: 'info', label: 'No cookie or login is needed. Both servers need a Referer of fprime.at, which every stream carries.' }
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
