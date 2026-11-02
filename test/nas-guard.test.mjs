// The guard of the NAS, run against stand-ins for systemctl, journalctl and docker: what does it do in each kind of trouble?
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SH = process.platform === 'win32' ? 'C:/Program Files/Git/bin/sh.exe' : 'sh';
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_m, d) => `/${d.toLowerCase()}`);
const hasShell = spawnSync(SH, ['-c', 'exit 0']).status === 0;

/** A world: `docker` works or not, what the journal says, whether containers run. Every command is written to a log. */
function world({ active = true, startsOk = true, journal = '', repairHelps = false, running = true, upFails = '' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  const bin = path.join(dir, 'bin');
  const dock = path.join(dir, 'docker-root', 'network', 'files');
  fs.mkdirSync(bin);
  fs.mkdirSync(dock, { recursive: true });
  fs.mkdirSync(path.join(dir, 'app'));
  fs.writeFileSync(path.join(dock, 'local-kv.db'), 'broken');
  const kv = posix(path.join(dock, 'local-kv.db'));
  const log = posix(path.join(dir, 'log'));
  const flag = posix(path.join(dir, 'active'));
  if (active) fs.writeFileSync(path.join(dir, 'active'), '');
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  stub('systemctl', `case "$*" in
  *is-active*) [ -f "${flag}" ]; exit $? ;;
  start*) if ${startsOk} || { ${repairHelps} && [ ! -f "${kv}" ]; }; then touch "${flag}"; else exit 1; fi ;;
  stop*) rm -f "${flag}" ;;
esac`);
  stub('journalctl', `echo '${journal}'`);
  stub('sleep', '');
  stub('curl', 'printf 200');
  stub('docker', `case "$*" in
  inspect*) echo ${running}; ;;
  *force-recreate*) echo recreated ;;
  *"compose up"*) ${upFails ? `echo '${upFails}'; exit 1` : 'echo started'} ;;
esac`);
  const run = () => spawnSync(SH, [posix(path.join(root, 'scripts/nas-guard.sh'))], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, APP_DIR: posix(path.join(dir, 'app')), DOCKER_ROOT: posix(path.join(dir, 'docker-root')), STATE_DIR: posix(path.join(dir, 'state')), SETTLE: '0' },
  });
  return { run, log: () => (fs.existsSync(path.join(dir, 'log')) ? fs.readFileSync(path.join(dir, 'log'), 'utf8') : ''), kvFiles: () => fs.readdirSync(dock) };
}

test('all is well: it touches nothing', { skip: !hasShell }, () => {
  const w = world({});
  assert.equal(w.run().status, 0);
  assert.doesNotMatch(w.log(), /compose up|start |stop /);
  assert.deepEqual(w.kvFiles(), ['local-kv.db']);
});

test('Docker just stopped: it is started, and the file stays', { skip: !hasShell }, () => {
  const w = world({ active: false });
  assert.equal(w.run().status, 0);
  assert.match(w.log(), /systemctl start/);
  assert.deepEqual(w.kvFiles(), ['local-kv.db']);
});

test('the damage of that night: the file is moved aside, never removed, and Docker starts', { skip: !hasShell }, () => {
  const w = world({ active: false, startsOk: false, repairHelps: true, journal: 'panic: invalid freelist page: 369' });
  const r = w.run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const files = w.kvFiles();
  assert.equal(files.length, 1);
  assert.match(files[0], /^local-kv\.db\.broken-\d{8}-\d{6}$/);
});

test('another reason for failing: nothing is moved', { skip: !hasShell }, () => {
  const w = world({ active: false, startsOk: false, journal: 'failed to mount: no space left' });
  assert.equal(w.run().status, 1);
  assert.deepEqual(w.kvFiles(), ['local-kv.db']);
});

test('repairs that do not help stop after three', { skip: !hasShell }, () => {
  const w = world({ active: false, startsOk: false, repairHelps: false, journal: 'invalid freelist page' });
  for (let i = 0; i < 6; i += 1) w.run();
  assert.equal((w.log().match(/stop docker/g) || []).length <= 1, true, 'there is no file left to move after the first time');
});

test('a container stopped for a moment gets a second look; then it is started', { skip: !hasShell }, () => {
  const w = world({ running: false });
  assert.equal(w.run().status, 0);
  assert.doesNotMatch(w.log(), /compose up/, 'an update may be going on');
  assert.equal(w.run().status, 0);
  assert.match(w.log(), /compose up -d --no-build/);
  assert.doesNotMatch(w.log(), /--build(?!\S)|down|rm /, 'never rebuilds or removes');
});

test('containers that remember the lost network are recreated', { skip: !hasShell }, () => {
  const w = world({ running: false, upFails: 'network 4984 not found' });
  w.run();
  assert.equal(w.run().status, 0);
  assert.match(w.log(), /--force-recreate/);
});

test('the installer sets which services start, keeps the rest of the settings and a copy', { skip: !hasShell }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-env-'));
  const file = path.join(dir, '.env');
  const before = 'APP_SECRET=keep-me\nCOMPOSE_PROFILES=tunnel,watchdog\nTRUST_PROXY=true\n';
  fs.writeFileSync(file, before);
  const run = () => spawnSync(SH, [posix(path.join(root, 'scripts/install-nas-guard.sh'))], { encoding: 'utf8', env: { ...process.env, ONLY_PROFILES: '1', ENV_FILE: posix(file) } });
  assert.equal(run().status, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'APP_SECRET=keep-me\nCOMPOSE_PROFILES=tunnel,watchdog,translate,tgbridge,embed,whisper\nTRUST_PROXY=true\n');
  assert.equal(fs.readFileSync(`${file}.before-guard`, 'utf8'), before);
  fs.writeFileSync(file, 'A=1\n');
  assert.equal(run().status, 0);
  assert.match(fs.readFileSync(file, 'utf8'), /^A=1\nCOMPOSE_PROFILES=tunnel/);
});

test('containers of other projects that lost their network are brought back, not only the messenger', { skip: !hasShell }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-all-'));
  const bin = path.join(dir, 'bin');
  const app = path.join(dir, 'app');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(app, 'scripts'), { recursive: true });
  const log = posix(path.join(dir, 'log'));
  fs.writeFileSync(path.join(app, 'scripts/docker-restore-networks.sh'), `echo restore >> "${log}"\n`);
  const stub = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('systemctl', 'exit 0');
  stub('curl', 'printf 200');
  stub('docker', `case "$*" in
  "ps -a --filter status=exited"*) echo gitea; echo old-job ;;
  *".State.Error"*gitea) echo "failed to set up container networking: network 51f3 not found" ;;
  *".State.Error"*) echo "" ;;
  *) echo true ;;
esac`);
  const r = spawnSync(SH, [posix(path.join(root, 'scripts/nas-guard.sh'))], { encoding: 'utf8', env: { ...process.env, PATH: `${posix(bin)}:${process.env.PATH}`, APP_DIR: posix(app), STATE_DIR: posix(path.join(dir, 'state')) } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /bringing them back: 1/);
  assert.equal(fs.readFileSync(path.join(dir, 'log'), 'utf8').trim(), 'restore');
});
