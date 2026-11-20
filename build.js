// node build.js: providers/<id>.js = src/<id>.js + tail.js, and sets hasSettings in manifest.json.
// Edit src/ and tail.js, rebuild, bump versions in manifest.json, commit providers/ too (Nuvio fetches providers/).
const fs = require('node:fs');
const path = require('node:path');

const tail = fs.readFileSync(path.join(__dirname, 'tail.js'), 'utf8');
const manifestPath = path.join(__dirname, 'manifest.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

fs.mkdirSync(path.join(__dirname, 'providers'), { recursive: true });
for (const s of manifest.scrapers) {
  const file = path.basename(s.filename);
  fs.writeFileSync(path.join(__dirname, 'providers', file), fs.readFileSync(path.join(__dirname, 'src', file), 'utf8') + tail);
  s.hasSettings = true;
  console.log('built', s.filename);
}
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
