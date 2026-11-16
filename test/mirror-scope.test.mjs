// The second copy of the files keeps what matters: personal chats and groups; a channel's files and a Telegram copy's videos are left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const script = `
import { q, migrate } from './server/src/db.js';
migrate();
import { copyExcluded } from './server/src/ops.js';
const now = Date.now();
const user = Number(q.run("INSERT INTO users (phone, name, created_at, last_seen) VALUES ('+998900000099', 'Тест', ?, ?)", now, now).lastInsertRowid);
const chat = (type, imported) => Number(q.run("INSERT INTO chats (type, title, imported_from, last_message_at, created_at) VALUES (?, 'x', ?, ?, ?)", type, imported, now, now).lastInsertRowid);
const file = (id) => q.run("INSERT INTO files (id, owner_id, name, mime, size, created_at) VALUES (?, ?, ?, 'application/octet-stream', 10, ?)", id, user, id, now);
const msg = (c, f, kind) => q.run("INSERT INTO messages (chat_id, sender_id, kind, text, file_id, created_at) VALUES (?, ?, ?, '', ?, ?)", c, user, kind, f, now);
const direct = chat('direct', null);
const group = chat('group', null);
const channel = chat('channel', null);
const tgGroup = chat('group', 'tgbridge');
const tgChannel = chat('group', 'tgbridge');
const tgUser = chat('group', 'tgbridge');
q.run("INSERT INTO tg_chats (user_id, tg_chat, title, chat_id) VALUES (?, '1', 'g', ?)", user, tgGroup);
q.run("INSERT INTO tg_chats (user_id, tg_chat, title, chat_id) VALUES (?, '2', 'c', ?)", user, tgChannel);
q.run("INSERT INTO tg_chats (user_id, tg_chat, title, chat_id) VALUES (?, '3', 'u', ?)", user, tgUser);
q.run("UPDATE tg_chats SET kind = 'group' WHERE chat_id = ?", tgGroup);
q.run("UPDATE tg_chats SET kind = 'channel' WHERE chat_id = ?", tgChannel);
q.run("UPDATE tg_chats SET kind = 'user' WHERE chat_id = ?", tgUser);
const cases = {
  native_direct: [direct, 'file'], native_group: [group, 'image'], native_channel: [channel, 'image'],
  tg_group_photo: [tgGroup, 'image'], tg_group_video: [tgGroup, 'video'], tg_channel_doc: [tgChannel, 'file'], tg_user_video: [tgUser, 'video'], tg_user_doc: [tgUser, 'file'],
  native_video: [direct, 'video'],
};
for (const [name, [c, kind]] of Object.entries(cases)) { file(name); msg(c, name, kind); }
file('no_message');
file('shared'); msg(channel, 'shared', 'image'); msg(group, 'shared', 'image');   // in a channel and in a group at once: kept
const skip = [...copyExcluded()].sort();
process.env.BACKUP_FILES_SCOPE = 'all';
const all = copyExcluded().size;
console.log(JSON.stringify({ skip, all }));
`;

test('the second copy of files: channels and the videos of Telegram copies are left out, what was made here and what is shared stays', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-mirror-'));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, encoding: 'utf8',
    env: { ...process.env, DATA_DIR: dir, NODE_ENV: 'development', LOG_LEVEL: 'error', PORT: '21390', NODE_OPTIONS: '', NODE_TEST_CONTEXT: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out.skip, ['native_channel', 'tg_channel_doc', 'tg_group_video', 'tg_user_video']);
  assert.equal(out.all, 0, 'scope "all" copies everything');
});
