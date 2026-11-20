# nuvio-yosu

One Nuvio plugin repository, nine separate providers: 4KHDHub, UHDMovies, Vidlink, Castle, MovieBlast, MoviesDrive,
Dulo, Movy, frameXTV. Each is its own entry in `manifest.json` and its own file in `providers/`, so Nuvio lists and
toggles them individually. They run inside Nuvio on the playing device, so IP-locked links (Dulo) work.

Add this in Nuvio as a plugin repository:

    https://raw.githubusercontent.com/Dazaike/nuvio-yosu/main/manifest.json

After editing a provider, bump its `version` in `manifest.json` so Nuvio refetches it.

## Self-host instead (optional)

    node serve.js          # port 8787, or: node serve.js 9000

Prints a `http://<ip>:8787/manifest.json` URL for this device or others on your Wi-Fi. Nuvio must allow plain `http://`.

## Not included

The addon's server-side extras (resolution filter, size limits, block words, provider order, smart stream testing and the
dashboard) need a server. They stay in `nuvio-yoru-addon`; use Nuvio's own filters here.

## Settings

Every provider has its own gear in Nuvio (settings are stored per provider): resolutions to show (4K, 1080p, 720p, 480p,
360p), minimum and maximum size in GB, blocked words, hide subtitles, and sort (provider's order, best quality, largest).
Streams with no readable resolution or size are kept. The code is `tail.js`, appended to each `src/<id>.js` by `node build.js`;
edit those, rebuild, and commit `providers/` (that is what Nuvio fetches).
