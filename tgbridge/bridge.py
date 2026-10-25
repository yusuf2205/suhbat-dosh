"""Bridge between Telegram accounts and Suhbat-dosh. One session per Suhbat-dosh user whom the administrator has allowed.

Safety rules built into this service:
  * it listens only inside the Docker network and every request needs the shared secret (BRIDGE_TOKEN);
  * Telegram sessions are stored encrypted (AES-256-GCM, key TGBRIDGE_KEY from the environment, never in the database);
  * personal (one-to-one) chats are mirrored by default; groups and channels only when chosen;
  * a chat is read-only unless two-way was switched on for it;
  * Telegram's own service chat (login codes), bots and Saved Messages are never mirrored;
  * message texts are never written to the log;
  * /logout ends the session on Telegram's side too and deletes every file kept for that account.

Set TGBRIDGE_MOCK=1 to run without Telegram (used by the tests): fake accounts and fake chats.
"""
import asyncio
import base64
import hmac
import json
import os
import re
import time
from collections import deque

from aiohttp import ClientSession, ClientTimeout, web
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

DATA = os.environ.get("DATA_DIR", "/data")
PORT = int(os.environ.get("PORT", "9200"))
TOKEN = os.environ.get("BRIDGE_TOKEN", "")
SERVER = os.environ.get("SERVER_URL", "http://suhbat:3000").rstrip("/")
API_ID = int(os.environ.get("TG_API_ID", "0") or 0)
API_HASH = os.environ.get("TG_API_HASH", "")
MOCK = os.environ.get("TGBRIDGE_MOCK") == "1"
BACKFILL_MESSAGES = int(os.environ.get("BACKFILL_MESSAGES", "150"))
BACKFILL_DIALOGS = int(os.environ.get("BACKFILL_DIALOGS", "200"))
TELEGRAM_SERVICE = 777000
HEAVY = asyncio.Semaphore(int(os.environ.get("BRIDGE_HEAVY_JOBS", "10")))   # history copies and light passes running at once
RECENT_DAYS = 3        # the light pass looks only at chats with something new in the last days
# media: photos and voice messages are copied; videos are prepared but OFF until BRIDGE_VIDEO=1
MEDIA_MAX = int(os.environ.get("BRIDGE_MEDIA_MAX_MB", "25")) * 1024 * 1024
VIDEO_ON = os.environ.get("BRIDGE_VIDEO") == "1"
VIDEO_MAX = int(os.environ.get("BRIDGE_VIDEO_MAX_MB", "50")) * 1024 * 1024
BACKFILL_MEDIA = os.environ.get("BACKFILL_MEDIA") == "1"   # also download the pictures of the old history (heavy)


def log(*a):
    # never put message text or names here
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def _key():
    raw = os.environ.get("TGBRIDGE_KEY", "")
    key = base64.b64decode(raw) if raw else b""
    if len(key) != 32:
        raise SystemExit("TGBRIDGE_KEY must be 32 random bytes in base64 (openssl rand -base64 32)")
    return key


def seal(text: str) -> bytes:
    nonce = os.urandom(12)
    return b"S1" + nonce + AESGCM(_key()).encrypt(nonce, text.encode(), b"tgbridge")


def unseal(blob: bytes) -> str:
    if blob[:2] != b"S1":
        raise ValueError("bad session file")
    return AESGCM(_key()).decrypt(blob[2:14], blob[14:], b"tgbridge").decode()


def write_secret(path: str, data: bytes):
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


# ---------------------------------------------------------------- one Telegram account
class MockClient:
    """A stand-in for Telethon so the whole path can be tested without an account."""

    def __init__(self):
        self.authorized = False
        self.n = 1000

    async def connect(self):
        pass

    async def is_user_authorized(self):
        return self.authorized

    async def dialogs(self):
        return [{"id": -1001, "title": "Семья (мок)", "type": "group", "unread": 2},
                {"id": 777, "title": "Дилшод (мок)", "type": "user", "unread": 0},
                {"id": 778, "title": "Мадина (мок)", "type": "user", "unread": 1},
                {"id": -1002, "title": "Новости (мок)", "type": "channel", "unread": 5}]

    async def history(self, chat_id, limit):
        base = int(time.time() * 1000) - 86400_000
        return [{"tg_msg": 1 + i, "author": "Дилшод (мок)", "out": i % 2 == 1, "text": f"старое сообщение {i + 1}", "ts": base + i * 60_000} for i in range(3)]

    async def send(self, chat_id, text, reply_to=None):
        self.n += 1
        return self.n

    async def send_file_bytes(self, chat_id, data, name, kind, caption, reply_to=None, duration=0):
        self.n += 1
        self.last_file = {"chat": chat_id, "kind": kind, "name": name, "size": len(data), "caption": caption}
        return self.n

    async def log_out(self):
        self.authorized = False

    def is_connected(self):
        return True


def telethon_client(session_str=""):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    return TelegramClient(StringSession(session_str), API_ID, API_HASH, device_model="Suhbat-dosh bridge", app_version="1.0", lang_code="ru")


def display_name(u):
    if u is None:
        return ""
    return " ".join(x for x in [getattr(u, "first_name", "") or "", getattr(u, "last_name", "") or ""] if x).strip() or getattr(u, "title", "") or getattr(u, "username", "") or ""


KINDS = {"photo": "[Фото]", "video": "[Видео]", "voice": "[Голосовое сообщение]", "audio": "[Аудио]", "video_note": "[Видеосообщение]",
         "sticker": "[Стикер]", "gif": "[GIF]", "document": "[Файл]", "poll": "[Опрос]", "geo": "[Геопозиция]", "contact": "[Контакт]"}


def describe(msg) -> str:
    text = (getattr(msg, "message", "") or "").strip()
    kind = ""
    for attr in ("sticker", "voice", "video_note", "gif", "photo", "video", "audio", "poll", "geo", "contact", "document"):
        if getattr(msg, attr, None):
            kind = KINDS[attr]
            break
    if kind and getattr(msg, "sticker", None):
        alt = getattr(getattr(msg, "file", None), "emoji", "") or ""
        kind = f"{kind} {alt}".strip()
    return f"{kind} {text}".strip() if kind else text


class Acct:
    def __init__(self, uid: str):
        self.uid = uid
        self.client = None
        self.login = None          # { qr, task, status, url, started }
        self.me = None             # { name, username }
        self.auto_private = True   # mirror every one-to-one chat
        self.chats = {}            # tg chat id (str) -> { two_way: bool }
        self.sent = deque(maxlen=500)   # ids this service sent itself (their echo is not forwarded back)
        self.sent_edit = set()
        self.backfill = {"state": "idle", "done": 0, "total": 0}
        self.bf_task = None
        self.last_sync = 0.0
        self.prof_at = {}          # chat -> when its name / @username / phone / photo were last sent
        self.synced = False        # the first complete copy of the personal chats has finished

    @property
    def session_file(self):
        return os.path.join(DATA, f"session-{self.uid}.bin")

    @property
    def list_file(self):
        return os.path.join(DATA, f"chats-{self.uid}.json")

    def load_list(self):
        try:
            with open(self.list_file, encoding="utf-8") as f:
                d = json.load(f)
            self.auto_private = bool(d.get("auto_private", True))
            self.synced = bool(d.get("synced", False))
            self.chats = {str(k): v for k, v in d.get("chats", {}).items()}
        except Exception:
            pass

    def save_list(self):
        write_secret(self.list_file, json.dumps({"auto_private": self.auto_private, "chats": self.chats, "synced": self.synced}).encode())

    async def persist_session(self):
        write_secret(self.session_file, seal("mock" if MOCK else self.client.session.save()))

    async def wipe(self):
        if self.bf_task:
            self.bf_task.cancel()
        for p in (self.session_file, self.list_file, self.session_file + ".tmp", self.list_file + ".tmp"):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass
        self.me = None
        self.chats = {}
        self.client = None
        self.login = None


ACCTS: dict = {}


def acct(uid) -> Acct:
    uid = str(uid)
    if not re.fullmatch(r"\d{1,12}", uid):
        raise web.HTTPBadRequest(text=json.dumps({"error": "invalid_input"}), content_type="application/json")
    if uid not in ACCTS:
        ACCTS[uid] = Acct(uid)
    return ACCTS[uid]


# ---------------------------------------------------------------- to the server
_HTTP = None
RETRY: deque = deque(maxlen=20000)   # messages the server could not take yet (it was restarting)
LOCKS: dict = {}


def _http():
    """One keep-alive connection pool for everything: no new connection (and no handshake) per message."""
    global _HTTP
    if _HTTP is None or _HTTP.closed:
        from aiohttp import TCPConnector
        _HTTP = ClientSession(timeout=ClientTimeout(total=15), connector=TCPConnector(limit=100, keepalive_timeout=60))
    return _HTTP


def chat_lock(uid, key):
    """Messages of one chat reach the server in the order they came; different chats and different people never wait for each other."""
    if len(LOCKS) > 20000:
        for k in [k for k, v in LOCKS.items() if not v.locked()][:10000]:
            LOCKS.pop(k, None)
    return LOCKS.setdefault((str(uid), str(key)), asyncio.Lock())


async def post_in(payload) -> bool:
    try:
        async with _http().post(f"{SERVER}/api/bridge/in", json=payload, headers={"Authorization": f"Bearer {TOKEN}"}) as r:
            return r.status < 500
    except Exception:
        return False


async def to_server(payload, locked=False):
    """Hand one message to Suhbat-dosh at once. If the server is not reachable the message waits in a queue and is sent again within seconds."""
    if locked:
        ok = await post_in(payload)
    else:
        async with chat_lock(payload.get("owner"), payload.get("tg_chat", "")):
            ok = await post_in(payload)
    if not ok:
        RETRY.append(payload)


async def flush_outbox():
    while RETRY:
        if not await post_in(RETRY[0]):
            return
        RETRY.popleft()


async def retry_loop():
    while True:
        await asyncio.sleep(5)
        if RETRY:
            await flush_outbox()


def private_ok(entity_id: int, entity) -> bool:
    """One-to-one chats with real people: not bots, not Telegram's own service chat (it carries login codes)."""
    if entity_id == TELEGRAM_SERVICE:
        return False
    return not getattr(entity, "bot", False) and not getattr(entity, "is_self", False)


def media_kind(msg):
    """Which kind of file this message carries and we are willing to copy: 'image', 'voice', 'video' (only when switched on) or None."""
    if getattr(msg, "voice", None):
        return "voice"
    if getattr(msg, "photo", None):
        return "image"
    if VIDEO_ON and (getattr(msg, "video", None) or getattr(msg, "video_note", None)) and not getattr(msg, "gif", None):
        return "video"
    return None


async def upload_media(a: Acct, msg, kind: str, meta: dict) -> bool:
    """Download the file of a message and hand it to Suhbat-dosh. False means: send the text placeholder instead."""
    f = getattr(msg, "file", None)
    size = getattr(f, "size", 0) or 0
    if size > (VIDEO_MAX if kind == "video" else MEDIA_MAX):
        return False
    try:
        data = await msg.download_media(file=bytes)
    except Exception as e:
        log("media download failed:", type(e).__name__)
        return False
    return await post_media(a, kind, data, {**meta, "w": getattr(f, "width", None) or "", "h": getattr(f, "height", None) or "", "duration": getattr(f, "duration", None) or ""})


PROFILE_EVERY = 6 * 3600


async def sync_profile(a: Acct, entity, key: str, kind: str, force: bool = False):
    """The name, @username, phone and profile photo of the other side of a chat, so the copy looks like the contact in Telegram.
    Sent at most every few hours per chat; the photo only when Telegram's photo id differs from the one the server already holds."""
    if MOCK or entity is None or not a.me:
        return False
    if not force and time.time() - a.prof_at.get(key, 0) < PROFILE_EVERY:
        return False
    a.prof_at[key] = time.time()
    try:
        photo = getattr(entity, "photo", None)
        photo_id = str(getattr(photo, "photo_id", "") or "")
        await to_server({
            "owner": a.uid, "tg_chat": key, "kind": kind, "profile": True, "title": display_name(entity) or "",
            "username": getattr(entity, "username", "") or "", "phone": getattr(entity, "phone", "") or "", "photo_id": photo_id,
        })
        if photo_id and a.chats.get(key, {}).get("photo") != photo_id:
            data = await a.client.download_profile_photo(entity, file=bytes)
            if data:
                params = {"owner": a.uid, "tg_chat": key, "photo_id": photo_id}
                async with _http().post(f"{SERVER}/api/bridge/photo", params=params, data=data, timeout=ClientTimeout(total=60),
                                        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/octet-stream"}) as r:
                    if r.status < 300 and key in a.chats:
                        a.chats[key]["photo"] = photo_id
        return True
    except asyncio.CancelledError:
        raise
    except Exception as e:
        log("profile sync skipped:", type(e).__name__)
        return False


async def post_media(a: Acct, kind: str, data, meta: dict) -> bool:
    if not data:
        return False
    params = {"owner": a.uid, "kind": kind, **{k: ("1" if v is True else "" if v is None or v is False else str(v)) for k, v in meta.items()}}
    try:
        async with _http().post(f"{SERVER}/api/bridge/media", params=params, data=data, timeout=ClientTimeout(total=180),
                                headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/octet-stream"}) as r:
            return r.status < 300
    except Exception as e:
        log("media upload failed:", type(e).__name__)
        return False


def may_answer(a: Acct, chat: str) -> bool:
    """May a message be written to this chat from here? A listed chat follows its own switch; a personal chat that is not listed yet
    (it has just appeared) may be answered by default while the personal chats are copied. The server has already checked its own switch."""
    rule = a.chats.get(chat)
    if rule is not None:
        return bool(rule.get("two_way"))
    try:
        return a.auto_private and int(chat) > 0   # personal chats have positive ids, groups and channels negative ones
    except ValueError:
        return False


def is_mirrored(a: Acct, key: str, kind: str) -> bool:
    """Is this Telegram chat one that is copied (chosen, or personal while the default is on)?"""
    return key in a.chats or (a.auto_private and kind == "user")


def attach_handlers(a: Acct):
    from telethon import events, utils

    @a.client.on(events.MessageEdited())
    async def on_edit(event):
        try:
            key = str(utils.get_peer_id(event.message.peer_id))
            kind = "user" if event.is_private else "channel" if event.is_channel and not event.is_group else "group"
            if not is_mirrored(a, key, kind) or event.message.id in a.sent_edit:
                return
            text = describe(event.message)
            if text:
                await to_server({"owner": a.uid, "edit": True, "tg_chat": key, "tg_msg": event.message.id, "text": text[:4000],
                                 "ts": int((event.message.edit_date or event.message.date).timestamp() * 1000)})
        except Exception as e:
            log("edit skipped:", type(e).__name__)

    @a.client.on(events.MessageDeleted())
    async def on_delete(event):
        try:
            # for personal chats Telegram does not say which chat: the server finds the messages by their number
            key = str(utils.get_peer_id(event.chat_id)) if getattr(event, "chat_id", None) else ""
            await to_server({"owner": a.uid, "deleted": True, "tg_chat": key, "ids": list(event.deleted_ids or [])[:500]})
        except Exception as e:
            log("delete skipped:", type(e).__name__)

    @a.client.on(events.MessageRead(inbox=True))
    async def on_read(event):
        try:
            key = str(event.chat_id) if getattr(event, "chat_id", None) else ""
            if key and is_mirrored(a, key, "user" if event.is_private else "group"):
                await to_server({"owner": a.uid, "read": True, "tg_chat": key, "max_id": event.max_id})
        except Exception as e:
            log("read skipped:", type(e).__name__)

    @a.client.on(events.NewMessage())
    async def on_message(event):
        try:
            chat_id = utils.get_peer_id(event.message.peer_id)
            key = str(chat_id)
            rule = a.chats.get(key)
            kind = "user" if event.is_private else "channel" if event.is_channel and not event.is_group else "group"
            chat = None
            if rule is None:
                if not (a.auto_private and kind == "user"):
                    return
                chat = await event.get_chat()
                if not private_ok(chat_id, chat):
                    return
            if event.message.id in a.sent:
                return
            text = describe(event.message)
            if not text:
                return
            if chat is None and kind == "user":
                chat = await event.get_chat()
            sender = await event.get_sender()
            mk = media_kind(event.message)
            if time.time() - a.prof_at.get(key, 0) >= PROFILE_EVERY:
                asyncio.create_task(delayed_profile(a, event, key, kind))   # after the message: the server creates the chat from it
            async with chat_lock(a.uid, key):
              if mk and await upload_media(a, event.message, mk, {
                "tg_chat": key, "chat_kind": kind, "title": display_name(chat) if chat is not None else "", "tg_msg": event.message.id,
                "author": display_name(sender) or "?", "out": bool(event.message.out), "caption": (event.message.message or "")[:4000],
                "ts": int(event.message.date.timestamp() * 1000), "reply_to": reply_id(event.message),
              }):
                return
              await to_server({
                "owner": a.uid, "tg_chat": key, "kind": kind, "title": display_name(chat) if chat is not None else "",
                "tg_msg": event.message.id, "author": display_name(sender) or "?", "out": bool(event.message.out),
                "text": text[:4000], "ts": int(event.message.date.timestamp() * 1000),
                "reply_to": reply_id(event.message),
              }, locked=True)
        except Exception as e:  # a bad message must not stop the others
            log("message skipped:", type(e).__name__)


async def delayed_profile(a: Acct, event, key: str, kind: str):
    await asyncio.sleep(3)
    try:
        await sync_profile(a, await event.get_chat(), key, kind)
    except Exception as e:
        log("profile sync skipped:", type(e).__name__)


def reply_id(msg):
    """The id of the message this one answers (a reply to a story or another odd header has none)."""
    return getattr(getattr(msg, "reply_to", None), "reply_to_msg_id", None)


async def copy_dialog(a: Acct, d, limit=None):
    """The recent history of one personal chat, oldest first."""
    msgs = []
    async for m in a.client.iter_messages(d.entity, limit=limit or BACKFILL_MESSAGES):
        if describe(m):
            msgs.append(m)
    for m in reversed(msgs):
        sender = await m.get_sender()
        mk = media_kind(m) if BACKFILL_MEDIA else None
        if mk and await upload_media(a, m, mk, {
            "tg_chat": str(d.id), "chat_kind": "user", "title": d.name or "", "backfill": True, "tg_msg": m.id, "author": display_name(sender) or "?",
            "out": bool(m.out), "caption": (getattr(m, "message", "") or "")[:4000], "ts": int(m.date.timestamp() * 1000), "reply_to": reply_id(m),
        }):
            continue
        await to_server({
            "owner": a.uid, "tg_chat": str(d.id), "kind": "user", "title": d.name or "", "backfill": True, "tg_msg": m.id,
            "author": display_name(sender) or "?", "out": bool(m.out), "text": describe(m)[:4000], "ts": int(m.date.timestamp() * 1000), "reply_to": reply_id(m),
        })
    await sync_profile(a, d.entity, str(d.id), "user")


async def run_backfill(a: Acct):
    """Copy the recent history of every personal chat once (quietly: no notifications, nothing unread)."""
    a.backfill = {"state": "queued", "done": 0, "total": 0}
    async with HEAVY:
        a.backfill = {"state": "running", "done": 0, "total": 0}
        await _run_backfill(a)


async def _run_backfill(a: Acct):
    try:
        if MOCK:
            dialogs_ = [d for d in await a.client.dialogs() if d["type"] == "user"]
            a.backfill["total"] = len(dialogs_)
            for d in dialogs_:
                for m in await a.client.history(d["id"], BACKFILL_MESSAGES):
                    await to_server({"owner": a.uid, "tg_chat": str(d["id"]), "kind": "user", "title": d["title"], "backfill": True, **m})
                a.backfill["done"] += 1
            a.backfill["state"] = "done"
            await to_server({"owner": a.uid, "sync_done": True})
            return
        todo = []
        async for d in a.client.iter_dialogs(limit=BACKFILL_DIALOGS):
            if d.is_user and private_ok(d.id, d.entity):
                todo.append(d)
        a.backfill["total"] = len(todo)
        for d in todo:
            try:
                await copy_dialog(a, d)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # one odd chat must not stop the other fifteen
                log("a chat was skipped in the history copy:", repr(e)[:100])
                a.backfill["errors"] = a.backfill.get("errors", 0) + 1
            a.backfill["done"] += 1
            await asyncio.sleep(0.6)  # be gentle with Telegram's limits
        a.backfill["state"] = "done"
        a.synced = True
        a.save_list()
        await to_server({"owner": a.uid, "sync_done": True})
    except asyncio.CancelledError:
        a.backfill["state"] = "stopped"
    except Exception as e:
        log("backfill failed:", repr(e)[:100])
        a.backfill["state"] = "error"


async def sync_recent(a: Acct):
    """A light pass over the newest messages of the chats that had activity lately: nothing a dropped connection missed stays missing."""
    if not a.me or not a.auto_private or a.backfill["state"] in ("running", "queued"):
        return
    n = 0
    async with HEAVY:
        recent = time.time() - RECENT_DAYS * 86400
        async for d in a.client.iter_dialogs(limit=BACKFILL_DIALOGS):
            key = str(d.id)
            if (d.is_user and private_ok(d.id, d.entity)) or key in a.chats:
                # the name, @username, phone and photo of every copied chat, however quiet it is (a few hours apart per chat)
                if await sync_profile(a, d.entity, key, "user" if d.is_user else "channel" if d.is_channel and not d.is_group else "group"):
                    await asyncio.sleep(0.3)
            if not (d.is_user and private_ok(d.id, d.entity)):
                continue
            if not (d.unread_count or (d.date and d.date.timestamp() > recent)):
                continue
            try:
                await copy_dialog(a, d, limit=40)
            except Exception as e:
                log("recent sync skipped a chat:", repr(e)[:80])
            n += 1
            await asyncio.sleep(0.4)
    a.last_sync = time.time()
    log("recent sync done for", a.uid, "chats:", n)


async def start_existing():
    """On start: continue with every saved session."""
    os.makedirs(DATA, exist_ok=True)
    for name in os.listdir(DATA):
        m = re.fullmatch(r"session-(\d{1,12})\.bin", name)
        if not m:
            continue
        a = acct(m.group(1))
        a.load_list()
        try:
            with open(a.session_file, "rb") as f:
                raw = unseal(f.read())
        except Exception:
            log("a saved session cannot be read: sign in again")
            continue
        if MOCK:
            a.client = MockClient()
            a.client.authorized = True
            a.me = {"name": "Мок Аккаунт", "username": f"mock_{a.uid}"}
            continue
        a.client = telethon_client(raw)
        await a.client.connect()
        if not await a.client.is_user_authorized():
            log("a session was ended on Telegram's side")
            await a.wipe()
            continue
        me = await a.client.get_me()
        a.me = {"name": display_name(me), "username": getattr(me, "username", "") or ""}
        attach_handlers(a)
        await asyncio.sleep(1.0)
        try:
            await a.client.catch_up()  # everything that arrived, was edited or deleted while this service was not running
        except Exception as e:
            log("catch-up failed:", type(e).__name__)
        log("connected account", a.uid)
        if not a.synced:
            a.bf_task = asyncio.create_task(delayed_backfill(a))


async def delayed_backfill(a: Acct):
    await asyncio.sleep(5)
    if a.me and a.backfill["state"] != "running":
        await run_backfill(a)


# ---------------------------------------------------------------- HTTP
@web.middleware
async def guard(request, handler):
    if request.path == "/health":
        return await handler(request)
    given = request.headers.get("Authorization", "")
    if not TOKEN or not hmac.compare_digest(given, f"Bearer {TOKEN}"):
        return web.json_response({"error": "forbidden"}, status=403)
    try:
        return await handler(request)
    except web.HTTPException:
        raise
    except Exception as e:
        log("error:", type(e).__name__)
        return web.json_response({"error": "bridge_error"}, status=500)


def who(request) -> Acct:
    return acct(request.query.get("u", ""))


async def accounts(_r):
    """For the administrator's panel: who is connected right now and how the first copy is going."""
    return web.json_response({"accounts": {u: {"connected": bool(a.me and a.client and a.client.is_connected()), "synced": a.synced, "backfill": a.backfill["state"]}
                                           for u, a in ACCTS.items() if a.me}})


async def health(_r):
    return web.json_response({"ok": True, "accounts": sum(1 for a in ACCTS.values() if a.me), "mock": MOCK})


async def login_task(a: Acct):
    L = a.login
    try:
        if MOCK:
            await asyncio.sleep(float(os.environ.get("MOCK_LOGIN_DELAY", "1.5")))
            a.client.authorized = True
            a.me = {"name": "Мок Аккаунт", "username": f"mock_{a.uid}"}
            await a.persist_session()
            a.save_list()
            L["status"] = "done"
            return
        while True:
            try:
                await L["qr"].wait(timeout=30)
                break
            except asyncio.TimeoutError:
                if time.time() - L["started"] > 120:
                    L["status"] = "expired"
                    return
                await L["qr"].recreate()
                L["url"] = L["qr"].url
            except Exception as e:
                from telethon.errors import SessionPasswordNeededError
                if isinstance(e, SessionPasswordNeededError):
                    L["status"] = "password"
                    return
                raise
        await finish_login(a)
    except Exception as e:
        log("login failed:", type(e).__name__)
        L["status"] = "error"


async def finish_login(a: Acct):
    me = await a.client.get_me()
    a.me = {"name": display_name(me), "username": getattr(me, "username", "") or ""}
    await a.persist_session()
    a.save_list()
    attach_handlers(a)
    a.login["status"] = "done"
    log("connected account", a.uid)


async def login_start(r):
    a = who(r)
    if a.me:
        return web.json_response({"error": "already_linked"}, status=409)
    if not MOCK and (not API_ID or not API_HASH):
        return web.json_response({"error": "no_api_keys"}, status=503)
    if a.login and a.login.get("task"):
        a.login["task"].cancel()
    if MOCK:
        a.client = MockClient()
        a.login = {"status": "waiting", "url": f"tg://login?token=MOCK{a.uid}", "started": time.time()}
    else:
        a.client = telethon_client()
        await a.client.connect()
        qr = await a.client.qr_login()
        a.login = {"status": "waiting", "qr": qr, "url": qr.url, "started": time.time()}
    a.login["task"] = asyncio.create_task(login_task(a))
    return web.json_response({"url": a.login["url"], "expires_in": 120})


async def login_status(r):
    a = who(r)
    L = a.login
    if not L:
        return web.json_response({"status": "none", "linked": a.me is not None, "account": a.me})
    return web.json_response({"status": L["status"], "linked": a.me is not None, "url": L.get("url"), "account": a.me if L["status"] == "done" else None})


async def login_password(r):
    a = who(r)
    L = a.login
    if not L or L["status"] != "password":
        return web.json_response({"error": "no_login"}, status=409)
    pw = (await r.json()).get("password", "")
    try:
        await a.client.sign_in(password=pw)
    except Exception as e:
        return web.json_response({"error": "wrong_password" if "Password" in type(e).__name__ else "bridge_error"}, status=400)
    await finish_login(a)
    return web.json_response({"status": "done", "account": a.me})


async def dialogs(r):
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    if MOCK:
        return web.json_response({"dialogs": await a.client.dialogs()})
    out = []
    async for d in a.client.iter_dialogs(limit=200):
        if d.is_user and not private_ok(d.id, d.entity):
            continue
        kind = "channel" if d.is_channel and not d.is_group else "group" if d.is_group else "user"
        out.append({"id": d.id, "title": d.name or "?", "type": kind, "unread": d.unread_count})
    return web.json_response({"dialogs": out})


async def set_chats(r):
    """{ auto_private, chats: [{ id, two_way }] }: the rules the bridge applies to what arrives and to what may be sent."""
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    body = await r.json()
    a.auto_private = bool(body.get("auto_private", True))
    a.chats = {str(c["id"]): {"two_way": bool(c.get("two_way")), "photo": str(c.get("photo") or "")} for c in body.get("chats", [])[:600]}
    a.save_list()
    return web.json_response({"ok": True, "count": len(a.chats)})


async def backfill(r):
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    if a.backfill["state"] != "running":
        a.bf_task = asyncio.create_task(run_backfill(a))
    return web.json_response({"ok": True})


async def backfill_status(r):
    return web.json_response(who(r).backfill)


async def send(r):
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    body = await r.json()
    chat = str(body.get("chat"))
    if not may_answer(a, chat):
        return web.json_response({"error": "read_only"}, status=403)
    text = str(body.get("text", ""))[:4000]
    if not text.strip():
        return web.json_response({"error": "empty"}, status=400)
    reply = body.get("reply_to")
    if MOCK:
        mid = await a.client.send(int(chat), text, reply)
    else:
        m = await a.client.send_message(int(chat), text, reply_to=int(reply) if reply else None)
        mid = m.id
    a.sent.append(mid)
    return web.json_response({"tg_msg": mid})


SEND_MAX = 50 * 1024 * 1024


def _ogg_opus(data: bytes):
    """WebM/Opus or M4A/AAC in, Ogg/Opus (mono, 48 kHz) out. PyAV carries its own ffmpeg libraries: nothing is installed in the system."""
    import io
    import av
    inp = av.open(io.BytesIO(data))
    buf = io.BytesIO()
    out = av.open(buf, "w", format="ogg")
    stream = out.add_stream("libopus", rate=48000)
    stream.bit_rate = 32000
    resampler = av.AudioResampler(format="s16", layout="mono", rate=48000)
    for frame in inp.decode(audio=0):
        for f in resampler.resample(frame):
            for pkt in stream.encode(f):
                out.mux(pkt)
    for f in resampler.resample(None):
        for pkt in stream.encode(f):
            out.mux(pkt)
    for pkt in stream.encode(None):
        out.mux(pkt)
    out.close()
    inp.close()
    return buf.getvalue()


async def to_ogg_opus(data: bytes):
    """Telegram shows a voice message only as Ogg/Opus; what a phone or browser records (WebM/Opus, M4A) is converted. None: failed."""
    try:
        out = await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, _ogg_opus, data), 60)
        return out or None
    except Exception as e:
        log("voice conversion failed:", type(e).__name__)
        return None


async def send_file(r):
    """A photo, voice message, video, audio or file written here goes to the Telegram chat (only where answering from here is allowed)."""
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    q = r.query
    chat = str(q.get("chat", ""))
    if not may_answer(a, chat):
        return web.json_response({"error": "read_only"}, status=403)
    kind = q.get("kind", "file")
    if kind not in ("image", "video", "voice", "audio", "file"):
        return web.json_response({"error": "unsupported"}, status=400)
    data = await r.read()
    if not data or len(data) > SEND_MAX:
        return web.json_response({"error": "file_too_big"}, status=413)
    name = re.sub(r"[^\w.\- ()]", "_", q.get("name", "file"))[:80] or "file"
    caption = q.get("caption", "")[:1000]
    reply = int(q["reply_to"]) if q.get("reply_to", "").isdigit() else None
    try:
        duration = int(float(q.get("duration") or 0))
    except ValueError:
        duration = 0
    if kind == "voice":
        converted = await to_ogg_opus(data)
        if converted:
            data, name = converted, "voice.ogg"
    if MOCK:
        mid = await a.client.send_file_bytes(int(chat), data, name, kind, caption, reply, duration)
    else:
        import io
        from telethon.tl.types import DocumentAttributeAudio
        f = io.BytesIO(data)
        f.name = name
        opts = {"caption": caption or None, "reply_to": reply}
        if kind == "voice":
            opts.update(voice_note=True, attributes=[DocumentAttributeAudio(duration=duration, voice=True)])
        elif kind == "video":
            opts.update(supports_streaming=True)
        elif kind == "file":
            opts.update(force_document=True)
        m = await a.client.send_file(int(chat), f, **opts)
        mid = m.id
    a.sent.append(mid)
    return web.json_response({"tg_msg": mid})


async def read_back(r):
    """The chat was read here: mark it read in Telegram too (only for chats that may be answered from here)."""
    a = who(r)
    if not a.me:
        return web.json_response({"error": "not_linked"}, status=409)
    body = await r.json()
    chat = str(body.get("chat"))
    if not may_answer(a, chat):
        return web.json_response({"error": "read_only"}, status=403)
    if not MOCK:
        await a.client.send_read_acknowledge(int(chat), max_id=int(body.get("max_id") or 0))
    else:
        a.read_acks = getattr(a, "read_acks", []) + [[chat, int(body.get("max_id") or 0)]]
    return web.json_response({"ok": True})


async def mock_event(r):
    """Tests only: something happened in Telegram (an edit, a deletion, a read) or ask what was sent back."""
    if not MOCK:
        return web.json_response({"error": "forbidden"}, status=403)
    a = who(r)
    b = await r.json()
    if b.get("type") == "acks":
        return web.json_response({"acks": getattr(a, "read_acks", [])})
    if not a.me:
        return web.json_response({"forwarded": False})
    key = str(b.get("chat", ""))
    if b["type"] == "edit":
        await to_server({"owner": a.uid, "edit": True, "tg_chat": key, "tg_msg": b["msg"], "text": b["text"], "ts": int(time.time() * 1000)})
    elif b["type"] == "delete":
        await to_server({"owner": a.uid, "deleted": True, "tg_chat": key if b.get("with_chat", True) else "", "ids": b["ids"]})
    elif b["type"] == "read":
        await to_server({"owner": a.uid, "read": True, "tg_chat": key, "max_id": b["max_id"]})
    return web.json_response({"forwarded": True})


async def logout(r):
    """End the session on Telegram's side and delete everything kept for this account."""
    a = who(r)
    try:
        if a.client:
            if MOCK:
                await a.client.log_out()
            else:
                if await a.client.is_user_authorized():
                    await a.client.log_out()
                await a.client.disconnect()
    except Exception as e:
        log("logout:", type(e).__name__)
    await a.wipe()
    return web.json_response({"ok": True})


async def mock_last(r):
    """Tests only: what was last sent to Telegram as a file."""
    if not MOCK:
        return web.json_response({"error": "forbidden"}, status=403)
    return web.json_response(getattr(who(r).client, "last_file", None) or {})


async def mock_message(r):
    """Tests only: pretend that a message arrived in Telegram."""
    if not MOCK:
        return web.json_response({"error": "forbidden"}, status=403)
    a = who(r)
    b = await r.json()
    key = str(b["chat"])
    kind = b.get("kind", "user")
    if not a.me:
        return web.json_response({"forwarded": False})
    if key not in a.chats and not (a.auto_private and kind == "user"):
        return web.json_response({"forwarded": False})
    await to_server({"owner": a.uid, "tg_chat": key, "kind": kind, "title": b.get("title", ""), "tg_msg": b["msg"], "author": b.get("author", "Кто-то"),
                     "out": bool(b.get("out")), "text": b["text"], "ts": int(time.time() * 1000), "reply_to": None})
    return web.json_response({"forwarded": True})


TINY = {
    "image": base64.b64decode("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="),
    "voice": b"OggS\x00\x02" + b"\x00" * 40,
    "video": b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00" * 40,
}


async def mock_media(r):
    """Tests only: a picture / voice message / video arrived in Telegram (a video only when videos are switched on)."""
    if not MOCK:
        return web.json_response({"error": "forbidden"}, status=403)
    a = who(r)
    b = await r.json()
    kind = b["kind"]
    key = str(b["chat"])
    if not a.me or (key not in a.chats and not a.auto_private) or (kind == "video" and not VIDEO_ON):
        return web.json_response({"forwarded": False})
    ok = await post_media(a, kind, TINY[kind], {"tg_chat": key, "chat_kind": b.get("chat_kind", "user"), "title": b.get("title", ""), "tg_msg": b["msg"],
                                               "author": b.get("author", "Кто-то"), "out": bool(b.get("out")), "caption": b.get("caption", ""), "ts": int(time.time() * 1000),
                                               "duration": b.get("duration", ""), "w": b.get("w", ""), "h": b.get("h", "")})
    return web.json_response({"forwarded": ok})


def app():
    a = web.Application(middlewares=[guard], client_max_size=SEND_MAX + 1024 * 1024)
    a.add_routes([
        web.get("/health", health), web.get("/accounts", accounts),
        web.post("/login/start", login_start), web.get("/login/status", login_status), web.post("/login/password", login_password),
        web.get("/dialogs", dialogs), web.post("/chats", set_chats), web.post("/send", send), web.post("/send-file", send_file), web.post("/logout", logout),
        web.post("/backfill", backfill), web.get("/backfill/status", backfill_status),
        web.post("/read", read_back), web.post("/mock/event", mock_event), web.post("/mock/message", mock_message), web.get("/mock/last", mock_last), web.post("/mock/media", mock_media),
    ])
    return a


async def main():
    if len(TOKEN) < 24:
        raise SystemExit("BRIDGE_TOKEN must be at least 24 characters")
    _key()
    await start_existing()
    runner = web.AppRunner(app())
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log("bridge listening on", PORT, "(mock)" if MOCK else "")
    asyncio.create_task(retry_loop())
    ticks = 0
    cursor = 0
    while True:
        await asyncio.sleep(30)
        ticks += 1
        if MOCK:
            continue
        # a few accounts per tick, so each is visited about every quarter of an hour however many there are
        live = [a for a in ACCTS.values() if a.me]
        if not live:
            continue
        per_tick = max(1, -(-len(live) // 30))
        for _ in range(per_tick):
            a = live[cursor % len(live)]
            cursor += 1
            try:
                # a session may have been ended from the phone (Settings -> Devices): then forget everything about that account
                if not await a.client.is_user_authorized():
                    log("a session was ended on Telegram's side")
                    await a.wipe()
                    continue
                if a.synced and time.time() - a.last_sync > 5 * 60:
                    await sync_recent(a)
            except Exception as e:
                log("account check:", type(e).__name__)


if __name__ == "__main__":
    asyncio.run(main())
