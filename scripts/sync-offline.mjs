// The Android app must offer "Nearby" even if the messenger was never loaded (a first start with no internet).
// Copies web/js/nearby.js with everything it imports into apps/mobile/www, next to the local launcher page.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const www = path.join(root, 'apps/mobile/www');
const entry = 'web/js/offline.js';
const seen = new Set();

function walk(rel) {
  if (seen.has(rel)) return;
  seen.add(rel);
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  // only static imports: what is loaded with import() is not needed on the offline page
  for (const m of src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]((?:\.{1,2}\/|\/shared\/)[^'"]+)['"]|^\s*import\s+['"]((?:\.{1,2}\/|\/shared\/)[^'"]+)['"]/gm)) {
    const spec = (m[1] || m[2]).split('?')[0];
    // in the browser "/shared" and "../../shared" from /js/ both mean /shared, the top-level folder of this repository
    const dep = spec.includes('shared/') ? spec.slice(spec.indexOf('shared/')) : path.posix.join(path.posix.dirname(rel), spec);
    walk(dep);
  }
}
walk(entry);

fs.rmSync(path.join(www, 'js'), { recursive: true, force: true });
fs.rmSync(path.join(www, 'shared'), { recursive: true, force: true });
fs.rmSync(path.join(www, 'app'), { recursive: true, force: true });
for (const rel of seen) {
  const to = path.join(www, rel.replace(/^web\//, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(path.join(root, rel), to);
}
fs.mkdirSync(path.join(www, 'app'), { recursive: true });
for (const f of ['styles.css', 'design2.css']) fs.copyFileSync(path.join(root, 'web', f), path.join(www, 'app', f));
console.log(`offline page: ${seen.size} modules copied`);
if ([...seen].some((f) => /\/(chat|main)\.js$/.test(f))) throw new Error('the offline page must not pull in the whole messenger');
