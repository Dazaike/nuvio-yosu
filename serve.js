// Serves this folder as a Nuvio plugin repository. No dependencies.
//   node serve.js [port]      default port 8787
// Add the printed manifest URL in Nuvio. The plugins run on the device that plays; this only hands out files.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.argv[2] || process.env.PORT) || 8787;
const ROOT = __dirname;
const TYPES = { '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
const SERVED = /^\/(manifest\.json|providers\/[\w.-]+\.js)$/;

http
  .createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (!SERVED.test(p)) {
      res.writeHead(404, headers);
      return res.end('not found');
    }
    fs.readFile(path.join(ROOT, p), (err, data) => {
      if (err) {
        res.writeHead(404, headers);
        return res.end('not found');
      }
      res.writeHead(200, { ...headers, 'Content-Type': TYPES[path.extname(p)] });
      res.end(data);
    });
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('Yosu plugin repository. Add one of these in Nuvio:');
    console.log(`  http://127.0.0.1:${PORT}/manifest.json   (this device)`);
    for (const list of Object.values(os.networkInterfaces()))
      for (const a of list || [])
        if (a.family === 'IPv4' && !a.internal) console.log(`  http://${a.address}:${PORT}/manifest.json   (other devices on the network)`);
  });
