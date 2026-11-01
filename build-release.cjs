// Explicit allowlist: never copy customer screenshots or arbitrary asset folders.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const root = __dirname, target = path.join(root, 'release');
const files = ['index.html', 'style.css', 'app.js', 'processor.js', 'manifest.webmanifest', 'service-worker.js', '.nojekyll', 'README.md', 'TEST-RESULTS.md', 'server.cjs', 'build-release.cjs', '.gitignore', 'tests/processor.cjs', 'assets/opencv.js', 'assets/OPENCV-LICENSE.txt', 'assets/THIRD-PARTY.md', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png'];
fs.mkdirSync(target, { recursive: true });
// Refuse an unexpected preexisting payload instead of silently publishing it.
function walk(dir, prefix = '') { return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name), prefix + e.name + '/') : [prefix + e.name]); }
for (const file of walk(target)) if (!files.includes(file)) throw Error('Unexpected release file: ' + file);
for (const file of files) {
  const from = path.join(root, file), to = path.join(target, file);
  if (!fs.lstatSync(from).isFile()) throw Error('Not a regular file: ' + file);
  fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to);
  if (!fs.readFileSync(from).equals(fs.readFileSync(to))) throw Error('Copy mismatch: ' + file);
}
const fingerprint = crypto.createHash('sha256'); for (const file of files) fingerprint.update(file).update(fs.readFileSync(path.join(target, file)));
console.log(JSON.stringify({ directory: target, files: files.length, sha256: fingerprint.digest('hex'), customerImagesIncluded: false }, null, 2));
