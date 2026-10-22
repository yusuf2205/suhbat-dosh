// Several accounts on one device. The signed-in account keeps the normal `sid` cookie; every other account stays signed in
// in its own HttpOnly cookie `sid_<id>`, so switching is just swapping two cookies. Nothing is ever stored in the page.
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, int, now, parseCookies, sha256 } from './util.js';
import { getUser, publicUser } from './service.js';

const MAX_ACCOUNTS = 4;

function cookie(name, value, req, maxAge = Math.floor(config.sessionTtlMs / 1000)) {
  const parts = [`${name}=${value}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${maxAge}`];
  if (config.cookieSecure || req?.secure) parts.push('Secure');
  return parts.join('; ');
}
const clear = (name, req) => cookie(name, '', req, 0);

/** The signed-in user of a token, or null. */
function userOfToken(token) {
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0', sha256(token));
  if (!s || now() - s.last_active > config.sessionTtlMs) return null;
  const u = getUser(s.user_id);
  return u && !u.banned_at ? { user: u, session: s } : null;
}

const stashed = (req) => {
  const out = [];
  for (const [name, token] of Object.entries(parseCookies(req.headers.cookie))) {
    const m = /^sid_(\d+)$/.exec(name);
    if (!m) continue;
    const found = userOfToken(token);
    if (found && found.user.id === Number(m[1])) out.push({ id: found.user.id, user: found.user, token });
  }
  return out;
};

export function accountsRouter() {
  const r = express.Router();

  r.get('/accounts', (req, res) => {
    const cur = userOfToken(parseCookies(req.headers.cookie).sid);
    const others = stashed(req).filter((a) => !cur || a.id !== cur.user.id);
    res.json({
      max: MAX_ACCOUNTS,
      accounts: [
        ...(cur ? [{ ...publicUser(cur.user, cur.user.id), current: true }] : []),
        ...others.map((a) => ({ ...publicUser(a.user, a.id), current: false })),
      ],
    });
  });

  /** Put the current account aside (it stays signed in) so that another one can sign in. */
  r.post('/accounts/stash', (req, res) => {
    const cur = userOfToken(parseCookies(req.headers.cookie).sid);
    if (!cur) throw new HttpError(401, 'unauthorized');
    if (stashed(req).filter((a) => a.id !== cur.user.id).length + 1 >= MAX_ACCOUNTS) throw new HttpError(400, 'too_many_accounts');
    const token = parseCookies(req.headers.cookie).sid;
    res.setHeader('Set-Cookie', [cookie(`sid_${cur.user.id}`, token, req), clear('sid', req)]);
    res.json({ ok: true });
  });

  /** Make another account the current one. Works even when the current session has expired. */
  r.post('/accounts/switch', (req, res) => {
    const target = int(req.body?.user_id, 'user_id');
    const t = stashed(req).find((a) => a.id === target);
    if (!t) throw new HttpError(404, 'not_found');
    const cookies = [cookie('sid', t.token, req), clear(`sid_${target}`, req)];
    const curToken = parseCookies(req.headers.cookie).sid;
    const cur = userOfToken(curToken);
    if (cur && cur.user.id !== target) cookies.push(cookie(`sid_${cur.user.id}`, curToken, req));
    res.setHeader('Set-Cookie', cookies);
    res.json({ ok: true });
  });

  /** Sign an account out of this device (its session is revoked). */
  r.delete('/accounts/:id', (req, res) => {
    const id = int(req.params.id, 'id');
    const t = stashed(req).find((a) => a.id === id);
    if (!t) throw new HttpError(404, 'not_found');
    q.run('UPDATE sessions SET revoked = 1 WHERE id = ?', userOfToken(t.token).session.id);
    res.setHeader('Set-Cookie', clear(`sid_${id}`, req));
    res.json({ ok: true });
  });

  return r;
}
