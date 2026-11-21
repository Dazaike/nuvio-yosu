/**
 * castle - Built from src/castle/
 * Generated: 2025-12-31T21:23:16.715Z
 */
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropSymbols = Object.getOwnPropertySymbols;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __propIsEnum = Object.prototype.propertyIsEnumerable;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __spreadValues = (a, b) => {
  for (var prop in b || (b = {}))
    if (__hasOwnProp.call(b, prop))
      __defNormalProp(a, prop, b[prop]);
  if (__getOwnPropSymbols)
    for (var prop of __getOwnPropSymbols(b)) {
      if (__propIsEnum.call(b, prop))
        __defNormalProp(a, prop, b[prop]);
    }
  return a;
};
var __async = (__this, __arguments, generator) => {
  return new Promise((resolve, reject) => {
    var fulfilled = (value) => {
      try {
        step(generator.next(value));
      } catch (e) {
        reject(e);
      }
    };
    var rejected = (value) => {
      try {
        step(generator.throw(value));
      } catch (e) {
        reject(e);
      }
    };
    var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
    step((generator = generator.apply(__this, __arguments)).next());
  });
};

// src/castle/constants.js
var TMDB_API_KEY = "439c478a771f35c05022f9feabcca01c";
var TMDB_BASE_URL = "https://api.themoviedb.org/3";
var CASTLE_BASE = "https://api.hlowb.com";
var PKG = "com.external.castle";
var CHANNEL = "IndiaA";
var CLIENT = "1";
var LANG = "en-US";
var API_HEADERS = {
  "User-Agent": "okhttp/4.9.3",
  "Accept": "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "Keep-Alive",
  "Referer": CASTLE_BASE
};
var PLAYBACK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  "Accept": "video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "identity",
  "Connection": "keep-alive",
  "Sec-Fetch-Dest": "video",
  "Sec-Fetch-Mode": "no-cors",
  "Sec-Fetch-Site": "cross-site",
  "DNT": "1"
};

// src/castle/http.js
function makeRequest(_0) {
  return __async(this, arguments, function* (url, options = {}) {
    try {
      const response = yield fetch(url, {
        method: options.method || "GET",
        headers: __spreadValues(__spreadValues({}, API_HEADERS), options.headers),
        body: options.body
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      console.error(`[Castle] Request failed for ${url}: ${error.message}`);
      throw error;
    }
  });
}
function extractCipherFromResponse(response) {
  return __async(this, null, function* () {
    const text = yield response.text();
    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error("Empty response");
    }
    try {
      const json = JSON.parse(trimmed);
      if (json && json.data && typeof json.data === "string") {
        return json.data.trim();
      }
    } catch (e) {
    }
    return trimmed;
  });
}
// Castle ids are 16-digit integers; some exceed 2^53 and JSON.parse would round them (wrong movieId -> "Movie doesn't exist").
function parseCastleJson(text) {
  return JSON.parse(text.replace(/:\s*(\d{16,})(?=\s*[,}\]])/g, ':"$1"'));
}
function extractDataBlock(obj) {
  if (obj && obj.data && typeof obj.data === "object") {
    return obj.data;
  }
  return obj || {};
}

// src/castle/tmdb.js
function getTMDBDetails(tmdbId, mediaType) {
  return __async(this, null, function* () {
    const endpoint = mediaType === "tv" ? "tv" : "movie";
    const url = `${TMDB_BASE_URL}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    const title = mediaType === "tv" ? data.name : data.title;
    const releaseDate = mediaType === "tv" ? data.first_air_date : data.release_date;
    const year = releaseDate ? parseInt(releaseDate.split("-")[0]) : null;
    return {
      title,
      year,
      tmdbId
    };
  });
}

// src/castle/decrypt.js
function decryptCastle(encryptedB64, securityKeyB64) {
  return __async(this, null, function* () {
    console.log("[Castle] Starting local AES-CBC decryption...");
    try {
      const CryptoJS = require("crypto-js");
      
      // Monkey-patch to bypass NuvioMobile QuickJS JNI typed array mapping bug
      if (typeof __crypto_aes_decrypt_raw !== 'undefined') {
        const originalDecrypt = CryptoJS.AES.decrypt;
        CryptoJS.AES.decrypt = function(cipher, key, options) {
          try {
            const wordArrayToBytes = (wordArray) => {
              const bytes = new Uint8Array(wordArray.sigBytes);
              for (let i = 0; i < wordArray.sigBytes; i++) {
                bytes[i] = (wordArray.words[i >>> 2] >>> (24 - (i % 4) * 8)) & 0xff;
              }
              return bytes;
            };
            const toUint8Array = (data) => {
              if (data instanceof Uint8Array) return data;
              if (data instanceof ArrayBuffer) return new Uint8Array(data);
              if (data && typeof data.length === 'number') return new Uint8Array(Array.prototype.slice.call(data));
              return new Uint8Array(0);
            };
            const data = typeof cipher === 'string'
              ? new Uint8Array(Array.from(atob(cipher), c => c.charCodeAt(0)))
              : (cipher.ciphertext ? wordArrayToBytes(cipher.ciphertext) : toUint8Array(cipher));
            const kBytes = wordArrayToBytes(key);
            const ivBytes = (options && options.iv) ? wordArrayToBytes(options.iv) : new Uint8Array(0);
            const mode = (options && options.mode) || 'AES-CBC';
            
            // Map Uint8Array (unsigned) to Int8Array (signed) to match Kotlin ByteArray
            const keyArg = typeof Int8Array !== 'undefined' ? new Int8Array(kBytes.buffer) : kBytes;
            const ivArg = typeof Int8Array !== 'undefined' ? new Int8Array(ivBytes.buffer) : ivBytes;
            const dataArg = typeof Int8Array !== 'undefined' ? new Int8Array(data.buffer) : data;
            
            const resBytes = __crypto_aes_decrypt_raw(mode, keyArg, ivArg, dataArg);
            const plain = new TextDecoder().decode(resBytes);
            return { toString: function() { return plain; } };
          } catch (err) {
            console.error("[Castle JNI Patch] Decrypt failed, falling back:", err);
            return originalDecrypt.call(CryptoJS.AES, cipher, key, options);
          }
        };
      }

      const CASTLE_SUFFIX = "T!BgJB";
      
      const securityKeyWords = CryptoJS.enc.Base64.parse(securityKeyB64);
      const suffixWords = CryptoJS.enc.Utf8.parse(CASTLE_SUFFIX);
      const keyMaterial = securityKeyWords.concat(suffixWords);
      
      let finalKey;
      if (keyMaterial.sigBytes < 16) {
        const padding = CryptoJS.lib.WordArray.create(new Array(16 - keyMaterial.sigBytes).fill(0));
        finalKey = keyMaterial.concat(padding);
      } else if (keyMaterial.sigBytes > 16) {
        finalKey = CryptoJS.lib.WordArray.create(keyMaterial.words.slice(0, 4), 16);
      } else {
        finalKey = keyMaterial;
      }
      
      const iv = finalKey;
      
      const decrypted = CryptoJS.AES.decrypt(encryptedB64, finalKey, {
        iv,
        mode: CryptoJS.mode.CBC,
        padding: CryptoJS.pad.Pkcs7
      });
      
      const result = decrypted.toString(CryptoJS.enc.Utf8);
      if (!result) {
        throw new Error("Decryption resulted in empty string (possible key/IV mismatch)");
      }
      
      console.log("[Castle] Local decryption successful");
      return result;
    } catch (error) {
      console.error(`[Castle] Local decryption failed: ${error.message}`);
      throw error;
    }
  });
}

// src/castle/api.js
function getSecurityKey() {
  return __async(this, null, function* () {
    console.log("[Castle] Fetching security key...");
    const url = `${CASTLE_BASE}/v0.1/system/getSecurityKey/1?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}`;
    const response = yield makeRequest(url);
    const data = yield response.json();
    if (data.code !== 200 || !data.data) {
      throw new Error(`Security key API error: ${JSON.stringify(data)}`);
    }
    console.log("[Castle] Security key obtained");
    return data.data;
  });
}
function searchCastle(securityKey, keyword, page = 1, size = 30) {
  return __async(this, null, function* () {
    console.log(`[Castle] Searching for: ${keyword}`);
    const params = new URLSearchParams({
      channel: CHANNEL,
      clientType: CLIENT,
      keyword,
      lang: LANG,
      mode: "1",
      packageName: PKG,
      page: page.toString(),
      size: size.toString()
    });
    const url = `${CASTLE_BASE}/film-api/v1.1.0/movie/searchByKeyword?${params.toString()}`;
    const response = yield makeRequest(url);
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return parseCastleJson(decrypted);
  });
}
function getDetails(securityKey, movieId) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching details for movieId: ${movieId}`);
    const url = `${CASTLE_BASE}/film-api/v1.9.9/movie?channel=${CHANNEL}&clientType=${CLIENT}&lang=${LANG}&movieId=${movieId}&packageName=${PKG}`;
    const response = yield makeRequest(url);
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return parseCastleJson(decrypted);
  });
}
function getVideoV1(securityKey, movieId, episodeId, languageId, resolution = 2) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching video (v1) for movieId: ${movieId}, languageId: ${languageId}`);
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const body = {
      mode: "1",
      appMarket: "GuanWang",
      clientType: CLIENT,
      woolUser: "false",
      apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
      androidVersion: "13",
      movieId: movieId.toString(),
      episodeId: episodeId.toString(),
      languageId: languageId.toString(),
      isNewUser: "true",
      resolution: resolution.toString(),
      packageName: PKG
    };
    const response = yield makeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return parseCastleJson(decrypted);
  });
}
function getVideo2(securityKey, movieId, episodeId, resolution = 2) {
  return __async(this, null, function* () {
    console.log(`[Castle] Fetching video (v2) for movieId: ${movieId}, episodeId: ${episodeId}`);
    const url = `${CASTLE_BASE}/film-api/v2.0.1/movie/getVideo2?clientType=${CLIENT}&packageName=${PKG}&channel=${CHANNEL}&lang=${LANG}`;
    const body = {
      mode: "1",
      appMarket: "GuanWang",
      clientType: CLIENT,
      woolUser: "false",
      apkSignKey: "ED0955EB04E67A1D9F3305B95454FED485261475",
      androidVersion: "13",
      movieId: movieId.toString(),
      episodeId: episodeId.toString(),
      isNewUser: "true",
      resolution: resolution.toString(),
      packageName: PKG
    };
    const response = yield makeRequest(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    const cipher = yield extractCipherFromResponse(response);
    const decrypted = yield decryptCastle(cipher, securityKey);
    return parseCastleJson(decrypted);
  });
}
function normTitle(t) {
  return (t || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
}
function findCastleMovieId(securityKey, tmdbInfo, mediaType) {
  return __async(this, null, function* () {
    const searchTerm = tmdbInfo.year ? `${tmdbInfo.title} ${tmdbInfo.year}` : tmdbInfo.title;
    const searchResult = yield searchCastle(securityKey, searchTerm);
    const data = extractDataBlock(searchResult);
    const rows = data.rows || [];
    if (rows.length === 0) {
      throw new Error("No search results found");
    }
    // movieType: 1 = TV shows, 2 = Movies, 5 = Anime (either)
    const wantType = mediaType === "tv" ? 1 : 2;
    const candidates = rows.filter((item) => (item.id || item.redirectId || item.redirectIdStr) && (!item.movieType || item.movieType === wantType || item.movieType === 5));
    const yearOf = (item) => item.publishTime ? new Date(Number(item.publishTime)).getUTCFullYear() : null;
    const wanted = normTitle(tmdbInfo.title);
    const pick = (list, requireYear) => {
      const yearDiff = (item) => tmdbInfo.year && yearOf(item) ? Math.abs(yearOf(item) - tmdbInfo.year) : null;
      const ok = requireYear ? list.filter((item) => yearDiff(item) !== null && yearDiff(item) <= 1) : list;
      return ok.slice().sort((a, b) => (yearDiff(a) === null ? 99 : yearDiff(a)) - (yearDiff(b) === null ? 99 : yearDiff(b)))[0];
    };
    // Exact title first; a loose "contains" match must also agree on the year, otherwise "Friends" lands on "School Friends".
    const exact = pick(candidates.filter((item) => normTitle(item.title || item.name) === wanted), false);
    const loose = exact || pick(candidates.filter((item) => {
      const t = normTitle(item.title || item.name);
      return t.includes(wanted) || wanted.includes(t);
    }), true);
    if (!loose) {
      throw new Error(`No matching title in Castle for "${tmdbInfo.title}"`);
    }
    const movieId = loose.id || loose.redirectId || loose.redirectIdStr;
    console.log(`[Castle] Found match: ${loose.title || loose.name} (id: ${movieId})`);
    return movieId.toString();
  });
}

// src/castle/utils.js
function getQualityValue(quality) {
  if (!quality)
    return 0;
  const cleanQuality = quality.toString().toLowerCase().replace(/^(sd|hd|fhd|uhd|4k)\s*/i, "").replace(/p$/, "").trim();
  const qualityMap = {
    "4k": 2160,
    "2160": 2160,
    "1440": 1440,
    "1080": 1080,
    "720": 720,
    "480": 480,
    "360": 360,
    "240": 240
  };
  if (qualityMap[cleanQuality]) {
    return qualityMap[cleanQuality];
  }
  const numQuality = parseInt(cleanQuality);
  if (!isNaN(numQuality) && numQuality > 0) {
    return numQuality;
  }
  return 0;
}
function formatSize(sizeValue) {
  if (typeof sizeValue !== "number" || sizeValue <= 0) {
    return "Unknown";
  }
  if (sizeValue > 1e9) {
    return `${(sizeValue / 1e9).toFixed(2)} GB`;
  }
  return `${(sizeValue / 1e6).toFixed(0)} MB`;
}
function resolutionToQuality(resolution) {
  const qualityMap = {
    1: "480p",
    2: "720p",
    3: "1080p"
  };
  return qualityMap[resolution] || `${resolution}p`;
}

// src/castle/index.js
function processVideoResponse(videoData, mediaInfo, seasonNum, episodeNum, resolution, languageInfo) {
  const streams = [];
  const data = extractDataBlock(videoData);
  const videoUrl = data.videoUrl;
  if (!videoUrl) {
    console.log("[Castle] No videoUrl found in response");
    return streams;
  }
  
  const subtitles = [];
  if (data.subtitles && Array.isArray(data.subtitles)) {
    data.subtitles.forEach((sub) => {
      if (sub.url) {
        subtitles.push({
          url: sub.url,
          language: sub.abbreviate || "Unknown",
          name: sub.title || sub.abbreviate || "Unknown",
          headers: PLAYBACK_HEADERS
        });
      }
    });
  }

  let mediaTitle = mediaInfo.title || "Unknown";
  if (mediaInfo.year) {
    mediaTitle += ` (${mediaInfo.year})`;
  }
  if (seasonNum && episodeNum) {
    mediaTitle = `${mediaInfo.title} S${String(seasonNum).padStart(2, "0")}E${String(episodeNum).padStart(2, "0")}`;
  }
  const quality = resolutionToQuality(resolution);
  if (data.videos && Array.isArray(data.videos)) {
    for (const video of data.videos) {
      let videoQuality = video.resolutionDescription || video.resolution || quality;
      videoQuality = videoQuality.replace(/^(SD|HD|FHD)\s+/i, "");
      const streamName = languageInfo ? `Castle ${languageInfo} - ${videoQuality}` : `Castle - ${videoQuality}`;
      streams.push({
        name: streamName,
        title: mediaTitle,
        url: video.url || videoUrl,
        quality: videoQuality,
        size: formatSize(video.size),
        headers: PLAYBACK_HEADERS,
        provider: "castle",
        subtitles
      });
    }
  } else {
    const streamName = languageInfo ? `Castle ${languageInfo} - ${quality}` : `Castle - ${quality}`;
    streams.push({
      name: streamName,
      title: mediaTitle,
      url: videoUrl,
      quality,
      size: formatSize(data.size),
      headers: PLAYBACK_HEADERS,
      provider: "castle",
      subtitles
    });
  }
  return streams;
}
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  return __async(this, null, function* () {
    console.log(`[Castle] Starting extraction for TMDB ID: ${tmdbId}, Type: ${mediaType}${mediaType === "tv" ? `, S:${seasonNum}E:${episodeNum}` : ""}`);
    try {
      const tmdbInfo = yield getTMDBDetails(tmdbId, mediaType);
      console.log(`[Castle] TMDB Info: "${tmdbInfo.title}" (${tmdbInfo.year || "N/A"})`);
      const securityKey = yield getSecurityKey();
      const movieId = yield findCastleMovieId(securityKey, tmdbInfo, mediaType);
      let details = yield getDetails(securityKey, movieId);
      let currentMovieId = movieId;
      if (mediaType === "tv" && seasonNum && episodeNum) {
        const data = extractDataBlock(details);
        const seasons = data.seasons || [];
        const season = seasons.find((s) => s.number === seasonNum);
        if (season && season.movieId && season.movieId !== movieId) {
          console.log(`[Castle] Fetching season ${seasonNum} details...`);
          details = yield getDetails(securityKey, season.movieId.toString());
          currentMovieId = season.movieId.toString();
        }
      }
      const detailsData = extractDataBlock(details);
      const episodes = detailsData.episodes || [];
      let episodeId = null;
      if (mediaType === "tv" && seasonNum && episodeNum) {
        const episode2 = episodes.find((e) => e.number === episodeNum);
        if (episode2 && episode2.id) {
          episodeId = episode2.id.toString();
        }
      } else if (episodes.length > 0) {
        episodeId = episodes[0].id.toString();
      }
      if (!episodeId) {
        throw new Error("Could not find episode ID");
      }
      const episode = episodes.find((e) => e.id.toString() === episodeId);
      const tracks = episode && episode.tracks || [];
      const resolution = 2;
      const allStreams = [];
      for (const track of tracks) {
        const langName = track.languageName || track.abbreviate || "Unknown";
        if (track.existIndividualVideo && track.languageId) {
          try {
            console.log(`[Castle] Fetching ${langName} (languageId: ${track.languageId})`);
            const videoData = yield getVideoV1(securityKey, currentMovieId, episodeId, track.languageId, resolution);
            const langStreams = processVideoResponse(videoData, tmdbInfo, seasonNum, episodeNum, resolution, `[${langName}]`);
            if (langStreams.length > 0) {
              console.log(`[Castle] \u2705 ${langName}: Found ${langStreams.length} streams`);
              allStreams.push(...langStreams);
            }
          } catch (error) {
            console.log(`[Castle] \u26A0\uFE0F ${langName}: Failed - ${error.message}`);
          }
        }
      }
      if (allStreams.length === 0) {
        console.log("[Castle] Falling back to shared stream (v2)");
        const videoData = yield getVideo2(securityKey, currentMovieId, episodeId, resolution);
        const sharedStreams = processVideoResponse(videoData, tmdbInfo, seasonNum, episodeNum, resolution, "[Shared]");
        allStreams.push(...sharedStreams);
      }
      allStreams.sort((a, b) => getQualityValue(b.quality) - getQualityValue(a.quality));
      console.log(`[Castle] Total streams found: ${allStreams.length}`);
      return allStreams;
    } catch (error) {
      console.error(`[Castle] Error: ${error.message}`);
      return [];
    }
  });
}
module.exports = { getStreams };

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
