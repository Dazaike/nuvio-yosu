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
