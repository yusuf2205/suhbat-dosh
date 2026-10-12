// Bot API end-to-end: create a bot, receive a message, answer with an inline keyboard, press a button, webhook.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4700 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let hook;
const hooks = [];

before(async () => {
  hook = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => { hooks.push({ headers: req.headers, body: JSON.parse(b) }); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-bots-')), BOT_WEBHOOK_ALLOW_PRIVATE: '1',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); hook?.close(); });

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.headers.get('set-cookie').split(';')[0], user: v.data.user };
}
const bot = (token, method, body) => call('', 'POST', `/bot${token}/${method}`, body);

test('bots: create, converse, inline keyboard, callbacks, webhook', async () => {
  const owner = await login('+998900000001', 'Owner');
  const user = await login('+998900000002', 'Alice');

  // creation rules
  assert.equal((await call(owner.cookie, 'POST', '/api/bots', { name: 'X', username: 'notabot_x' })).status, 400);
  const made = await call(owner.cookie, 'POST', '/api/bots', { name: 'Echo', username: 'echo_test_bot' });
  assert.equal(made.status, 201);
  const token = made.data.token;
  assert.match(token, /^\d+:[A-Za-z0-9_-]{20,}$/);
  assert.equal((await call(owner.cookie, 'POST', '/api/bots', { name: 'Dup', username: 'Echo_Test_Bot' })).status, 409);

  assert.equal((await bot('1:wrongwrongwrongwrongwrong', 'getMe')).status, 401);
  const me = await bot(token, 'getMe');
  assert.equal(me.data.ok, true);
  assert.equal(me.data.result.is_bot, true);
  assert.equal(me.data.result.username, 'echo_test_bot');

  // commands show up on the public profile
  const cm = await bot(token, 'setMyCommands', { commands: [{ command: 'start', description: 'Begin' }, { command: 'Help', description: 'Help me' }] });
  assert.equal(cm.data.ok, true);
  const found = await call(user.cookie, 'GET', '/api/users/search?q=echo_test');
  const botUser = found.data.users.find((u) => u.is_bot);
  assert.ok(botUser, 'bot is searchable');
  assert.deepEqual(botUser.commands.map((c) => c.command), ['start', 'help']);

  // user writes to the bot
  const chat = (await call(user.cookie, 'POST', '/api/chats/direct', { user_id: botUser.id })).data.chat;
  const sent = await call(user.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: '/start hello' });
  assert.equal(sent.status, 201);
  const ups = await bot(token, 'getUpdates', { timeout: 2 });
  assert.equal(ups.data.result.length, 1);
  const msg = ups.data.result[0].message;
  assert.equal(msg.text, '/start hello');
  assert.equal(msg.entities[0].type, 'bot_command');
  assert.equal(msg.from.first_name, 'Alice');
  assert.equal(msg.chat.id, chat.id);

  // offset confirms (drops) the update
  const again = await bot(token, 'getUpdates', { offset: ups.data.result[0].update_id + 1 });
  assert.equal(again.data.result.length, 0);

  // bot answers with an inline keyboard
  const reply = await bot(token, 'sendMessage', {
    chat_id: chat.id, text: 'Choose', reply_markup: { inline_keyboard: [[{ text: 'One', callback_data: 'one' }, { text: 'Site', url: 'https://example.com' }, { text: 'bad', url: 'javascript:alert(1)' }]] },
  });
  assert.equal(reply.data.ok, true);
  const list = await call(user.cookie, 'GET', `/api/chats/${chat.id}/messages`);
  const bm = list.data.messages.find((m) => m.text === 'Choose');
  assert.equal(bm.markup.inline_keyboard[0].length, 2, 'unsafe url button dropped');

  // pressing a button -> callback_query for the bot
  assert.equal((await call(user.cookie, 'POST', '/api/bots/callback', { message_id: bm.id, data: 'nope' })).status, 400);
  assert.equal((await call(user.cookie, 'POST', '/api/bots/callback', { message_id: bm.id, data: 'one' })).status, 200);
  const cbs = await bot(token, 'getUpdates', { timeout: 2 });
  const cq = cbs.data.result.find((u) => u.callback_query).callback_query;
  assert.equal(cq.data, 'one');
  assert.equal(cq.from.id, user.user.id);
  assert.equal((await bot(token, 'answerCallbackQuery', { callback_query_id: cq.id, text: 'Done' })).data.ok, true);

  // edit + delete
  const ed = await bot(token, 'editMessageText', { chat_id: chat.id, message_id: bm.id, text: 'Chosen: one' });
  assert.equal(ed.data.result.text, 'Chosen: one');
  const after = await call(user.cookie, 'GET', `/api/chats/${chat.id}/messages`);
  assert.equal(after.data.messages.find((m) => m.id === bm.id).markup, null);
  assert.equal((await bot(token, 'deleteMessage', { chat_id: chat.id, message_id: bm.id })).data.ok, true);

  // a bot cannot write to chats it is not in
  const other = await login('+998900000003', 'Bob');
  const oc = (await call(user.cookie, 'POST', '/api/chats/direct', { user_id: other.user.id })).data.chat;
  assert.equal((await bot(token, 'sendMessage', { chat_id: oc.id, text: 'hi' })).status, 403);

  // webhook mode: updates are POSTed, getUpdates is refused
  assert.equal((await bot(token, 'setWebhook', { url: `http://127.0.0.1:${hook.address().port}/h`, secret_token: 's3' })).data.ok, true);
  assert.equal((await bot(token, 'getUpdates')).status, 409);
  await call(user.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'ping' });
  for (let i = 0; i < 40 && !hooks.length; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].body.message.text, 'ping');
  assert.equal(hooks[0].headers['x-telegram-bot-api-secret-token'], 's3');

  // token reset invalidates the old one
  const reset = await call(owner.cookie, 'POST', `/api/bots/${me.data.result.id}/token`);
  assert.equal((await bot(token, 'getMe')).status, 401);
  assert.equal((await bot(reset.data.token, 'getMe')).data.ok, true);

  // the owner list never exposes tokens; non-owners cannot touch the bot
  const lst = await call(owner.cookie, 'GET', '/api/bots');
  assert.equal(lst.data.bots.length, 1);
  assert.ok(!JSON.stringify(lst.data).includes(reset.data.token));
  assert.equal((await call(user.cookie, 'DELETE', `/api/bots/${me.data.result.id}`)).status, 404);
  assert.equal((await call(owner.cookie, 'DELETE', `/api/bots/${me.data.result.id}`)).status, 200);
  assert.equal((await bot(reset.data.token, 'getMe')).status, 401);
});

test('bots: groups only deliver commands, mentions and replies', async () => {
  const owner = await login('+998900000011', 'Owner2');
  const member = await login('+998900000012', 'Member');
  const made = await call(owner.cookie, 'POST', '/api/bots', { name: 'Grp', username: 'grp_test_bot' });
  const token = made.data.token;
  const g = (await call(owner.cookie, 'POST', '/api/chats', { type: 'group', title: 'G', member_ids: [member.user.id, made.data.bot.id] })).data.chat;
  assert.ok(g, 'group created with the bot inside');
  await call(member.cookie, 'POST', `/api/chats/${g.id}/messages`, { text: 'just chatting' });
  await call(member.cookie, 'POST', `/api/chats/${g.id}/messages`, { text: '/ping' });
  await call(member.cookie, 'POST', `/api/chats/${g.id}/messages`, { text: 'hey @grp_test_bot' });
  const ups = await bot(token, 'getUpdates', {});
  assert.deepEqual(ups.data.result.map((u) => u.message.text), ['/ping', 'hey @grp_test_bot']);
});

test('BotFather: create, configure and delete a bot from a chat', async () => {
  const u = await login('+998900000031', 'Founder');
  const father = (await call(u.cookie, 'GET', '/api/bots/father')).data.user;
  assert.equal(father.username, 'botgrandfather');
  assert.equal(father.is_bot, true);
  const chat = (await call(u.cookie, 'POST', '/api/chats/direct', { user_id: father.id })).data.chat;
  const say = async (text) => {
    await call(u.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text });
    const ms = (await call(u.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
    return ms.filter((m) => m.sender_id === father.id).at(-1);
  };
  const press = async (m, data) => {
    const r = await call(u.cookie, 'POST', '/api/bots/callback', { message_id: m.id, data });
    assert.equal(r.status, 200);
    const ms = (await call(u.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
    return ms.filter((x) => x.sender_id === father.id);
  };

  assert.match((await say('/start')).text, /BotGrandFather/);
  assert.match((await say('/newbot')).text, /назвать/i);
  assert.match((await say('Мой магазин')).text, /username/i);
  assert.match((await say('shop')).text, /bot/i, 'invalid username is explained');
  const created = await say('my_shop_bot');
  assert.match(created.text, /создан/);
  const token = /(\d+:[A-Za-z0-9_-]{20,})/.exec(created.text)[1];
  assert.equal((await bot(token, 'getMe')).data.result.username, 'my_shop_bot');

  // configure through buttons
  const list = await say('/mybots');
  const btn = list.markup.inline_keyboard.flat().find((b) => b.text === '@my_shop_bot');
  const all = await press(list, btn.callback_data);
  const menu = all.find((m) => m.id === list.id);
  assert.match(menu.text, /Мой магазин/);
  const cmdBtn = menu.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('c:'));
  await press(menu, cmdBtn.callback_data);
  const done = await say('start - Запуск\nprice - Цены');
  assert.match(done.text, /Команды обновлены/);
  assert.deepEqual((await bot(token, 'getMyCommands')).data.result.map((c) => c.command), ['start', 'price']);

  // regenerate token
  const tBtn = menu.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('t:'));
  const afterT = await press(menu, tBtn.callback_data);
  const confirm = afterT.find((m) => m.id === menu.id);
  const ok = confirm.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('tok:'));
  const afterTok = await press(confirm, ok.callback_data);
  const fresh = /(\d+:[A-Za-z0-9_-]{20,})/.exec(afterTok.at(-1).text)[1];
  assert.notEqual(fresh, token);
  assert.equal((await bot(token, 'getMe')).status, 401);
  assert.equal((await bot(fresh, 'getMe')).data.ok, true);

  // someone else cannot press the owner's buttons to touch the bot
  const other = await login('+998900000032', 'Other');
  const oc = (await call(other.cookie, 'POST', '/api/chats/direct', { user_id: father.id })).data.chat;
  const spy = await call(other.cookie, 'POST', '/api/bots/callback', { message_id: list.id, data: btn.callback_data });
  assert.equal(spy.status, 404, 'not a member of that chat');
  void oc;

  // delete
  const back = afterTok.find((m) => m.id === menu.id);
  const backBtn = back.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('b:'));
  const menu2 = (await press(back, backBtn.callback_data)).find((m) => m.id === menu.id);
  const xBtn = menu2.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('x:'));
  const afterX = await press(menu2, xBtn.callback_data);
  const sure = afterX.find((m) => m.id === menu.id);
  await press(sure, sure.markup.inline_keyboard.flat().find((b) => b.callback_data.startsWith('xok:')).callback_data);
  assert.equal((await bot(fresh, 'getMe')).status, 401);
  assert.equal((await call(u.cookie, 'GET', '/api/bots')).data.bots.length, 0);
});
