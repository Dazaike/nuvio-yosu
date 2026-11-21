# nuvio-yosu

One Nuvio plugin repository, sixteen separate providers. Each is its own entry in `manifest.json` and its own file in
`providers/`, so Nuvio lists and toggles them individually. They run inside Nuvio on the playing device, so IP-locked
links (Dulo) work.

| Provider | Needs setup |
|---|---|
| 4KHDHub, UHDMovies, Vidlink, Castle, MovieBlast, MoviesDrive, Dulo, Movy, frameXTV | no |
| 7Movies | no |
| Cno | no (option: list every quality as its own entry) |
| MoanaTV | no (options: subtitles, extra servers, other-language audio, show unavailable servers) |
| Nepu | **yes** (needs setup): `cf_clearance` cookie and User-Agent |
| PopcornMovies | **yes** (needs setup): `cf_clearance` cookie and User-Agent (option: check servers before listing) |
| Vivarium | no (vivarium.st needs no cookie) |
| fprime | no (options: Aurora and Astra servers on or off, check the first segment, English subtitles) |

Add this in Nuvio as a plugin repository:

    https://raw.githubusercontent.com/Dazaike/nuvio-yosu/main/manifest.json

After editing a provider, bump its `version` (and the repo `version`) in `manifest.json` so Nuvio refetches it.

## Settings (gear on each provider)

Nuvio stores settings per provider, so set them once per provider.

1. The provider's own options come first. Only Nepu and PopcornMovies have the cookie and User-Agent fields. Their
   settings text points to the CF Clearance Copier tool in this repo (`tools/cf-cookie-copier`, below). Cookie values are
   never in this repo. Cookies are bound to the connection and User-Agent that earned them, so copy on the same network
   as the device you play on.
2. Then, on every provider: resolutions to show (4K, 1080p, 720p, 480p, 360p), minimum and maximum size in GB, blocked
   words, hide subtitles (not shown where the provider has its own subtitles switch), and sort (provider's order, best
   quality, largest).

Streams with no readable resolution or size are kept. "Auto (Best)" entries stay first under every sort. Size only
filters providers that report a size in the stream name or title (UHD-style direct links do; HLS providers do not).

The code is `tail.js`, appended to each `src/<id>.js` by `node build.js`; edit those, rebuild, and commit `providers/`
(that is what Nuvio fetches). `src/nepu.js` has no built-in cookie; `src/cno.js` has no cookie fields; `src/vivarium.js`
uses vivarium.st with no cookie and no settings of its own.

## CF Clearance Copier (tools/cf-cookie-copier)

Small Chrome/Edge extension (Manifest V3) that copies the `cf_clearance` cookie and your User-Agent. Load it unpacked:
`chrome://extensions` > Developer mode > Load unpacked > pick `tools/cf-cookie-copier`. Open the site (nepu.is,
popcornmovies.st) in that browser, pass the Cloudflare check, click the extension: it shows the cookie and your
User-Agent with Copy buttons, "Copy JSON", and "Save cf.json". If the browser was never challenged no cookie exists and
it says so. On a DDoS-Guard site (vivarium.st) it says there is no `cf_clearance` to copy. It only reads `cf_clearance`.
Nothing is sent anywhere.

## Self-host instead (optional)

    node serve.js          # port 8787, or: node serve.js 9000

Prints a `http://<ip>:8787/manifest.json` URL for this device or others on your Wi-Fi. Nuvio must allow plain `http://`.

## Not included

The addon's server-side extras (provider order across sources, smart stream testing, the dashboard) need a server. They
stay in `nuvio-yoru-addon`.

## Not part of Yosu

The six providers added in 1.1.0 (7Movies, Cno, MoanaTV, Nepu, PopcornMovies, Vivarium) used to be separate repos. Those
repos are deleted; Yosu is the only place they are published. `nuvio-flystream` (experimental, does not work) and
`nuvio-anicine` are separate repos and not part of Yosu.
