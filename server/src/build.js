import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// A fingerprint of the web client that this server is serving. It changes with every deployment,
// so open apps can notice "a new version is available" and reload without being reinstalled.
const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../../web');
const sharedDir = path.resolve(here, '../../shared');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

function fingerprint() {
  const h = crypto.createHash('sha1');
  for (const f of [...walk(webDir), ...walk(sharedDir)].sort()) {
    h.update(path.relative(webDir, f));
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 12);
}

export const BUILD_ID = fingerprint();

const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '../../package.json'), 'utf8'));
export const SERVER_VERSION = pkg.version;
