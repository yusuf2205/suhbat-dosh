"""Bridge between ONE Telegram account and Suhbat-dosh.

Safety rules built into this service:
  * it listens only inside the Docker network and every request needs the shared secret (BRIDGE_TOKEN);
  * the Telegram session is stored encrypted (AES-256-GCM, key TGBRIDGE_KEY from the environment, never in the database);
  * nothing is forwarded until a chat is explicitly chosen; a chat is read-only unless two-way was switched on for it;
  * message texts are never written to the log;
  * /logout ends the session on Telegram's side too and deletes every file this service keeps;
  * one account only.

Set TGBRIDGE_MOCK=1 to run without Telegram (used by the tests): a fake account and fake chats.
"""
import asyncio
import base64
import hmac
import json
import os
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
SESSION_FILE = os.path.join(DATA, "session.bin")
LIST_FILE = os.path.join(DATA, "chats.json")


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


class State:
    client = None
    login = None            # { qr, task, status, error }
    me = None               # { name, username }
    allowed: dict = {}      # tg chat id (str) -> { two_way: bool }
    sent: deque = deque(maxlen=500)   # message ids this service sent itself (their echo is not forwarded back)
    outbox: deque = deque(maxlen=200)


S = State()


def load_allowed():
    try:
        with open(LIST_FILE, encoding="utf-8") as f:
            S.allowed = {str(k): v for k, v in json.load(f).items()}
    except Exception:
        S.allowed = {}


def save_allowed():
    write_secret(LIST_FILE, json.dumps(S.allowed).encode())


# ---------------------------------------------------------------- Telegram (or the mock)
class MockClient:
    """A stand-in for Telethon so the whole path can be tested without an account."""

    def __init__(self):
        self.handlers = []
        self.connected = False
        self.n = 1000

    async def connect(self):
        self.connected = True

    async def is_user_authorized(self):
        return getattr(self, "authorized", False)

    async def get_me(self):
        return type("Me", (), {"first_name": "Мок", "last_name": "Аккаунт", "username": "mock_user"})()

    async def dialogs(self):
        return [{"id": -1001, "title": "Семья (мок)", "type": "group", "unread": 2},
                {"id": 777, "title": "Дилшод (мок)", "type": "user", "unread": 0},
                {"id": -1002, "title": "Новости (мок)", "type": "channel", "unread": 5}]

    async def send(self, chat_id, text, reply_to=None):
        self.n += 1
        return self.n

    async def log_out(self):
        self.authorized = False


def telethon_client(session_str=""):
    from telethon import TelegramClient
    from telethon.sessions import StringSession
    return TelegramClient(StringSession(session_str), API_ID, API_HASH, device_model="Suhbat-dosh bridge", app_version="1.0", lang_code="ru")


async def persist_session():
    if MOCK:
        write_secret(SESSION_FILE, seal("mock"))
        return
    write_secret(SESSION_FILE, seal(S.client.session.save()))


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


async def to_server(payload):
    """Hand one message to Suhbat-dosh. A short in-memory queue covers a server restart."""
    S.outbox.append(payload)
    await flush_outbox()


async def flush_outbox():
    async with ClientSession(timeout=ClientTimeout(total=10)) as http:
        while S.outbox:
            item = S.outbox[0]
            try:
                async with http.post(f"{SERVER}/api/bridge/in", json=item, headers={"Authorization": f"Bearer {TOKEN}"}) as r:
                    if r.status >= 500:
                        raise RuntimeError(r.status)
            except Exception:
                return  # try again with the next message
            S.outbox.popleft()


def attach_handlers():
    from telethon import events, utils

    @S.client.on(events.NewMessage())
    async def on_message(event):
        try:
            chat_id = str(utils.get_peer_id(event.message.peer_id))
            rule = S.allowed.get(chat_id)
            if not rule or event.message.id in S.sent:
                return
            text = describe(event.message)
            if not text:
                return
            sender = await event.get_sender()
            await to_server({
                "tg_chat": chat_id, "tg_msg": event.message.id, "author": display_name(sender) or "?", "out": bool(event.message.out),
                "text": text[:4000], "ts": int(event.message.date.timestamp() * 1000),
                "reply_to": event.message.reply_to.reply_to_msg_id if event.message.reply_to else None,
            })
        except Exception as e:  # a bad message must not stop the others
            log("message skipped:", type(e).__name__)


async def start_existing():
    """On start: continue with the saved session if there is one."""
    load_allowed()
    if not os.path.exists(SESSION_FILE):
        return
    try:
        with open(SESSION_FILE, "rb") as f:
            raw = unseal(f.read())
    except Exception:
        log("saved session cannot be read: sign in again")
        return
    if MOCK:
        S.client = MockClient()
        await S.client.connect()
        S.client.authorized = True
        S.me = {"name": "Мок Аккаунт", "username": "mock_user"}
        return
    S.client = telethon_client(raw)
    await S.client.connect()
    if not await S.client.is_user_authorized():
        log("the session was ended on Telegram's side")
        await wipe()
        return
    me = await S.client.get_me()
    S.me = {"name": display_name(me), "username": getattr(me, "username", "") or ""}
    attach_handlers()
    log("connected")


async def wipe():
    for p in (SESSION_FILE, LIST_FILE, SESSION_FILE + ".tmp", LIST_FILE + ".tmp"):
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    S.me = None
    S.allowed = {}
    S.client = None
    S.login = None


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


async def health(_r):
    return web.json_response({"ok": True, "linked": S.me is not None, "mock": MOCK})


async def login_task(first=True):
    L = S.login
    try:
        if MOCK:
            await asyncio.sleep(float(os.environ.get("MOCK_LOGIN_DELAY", "1.5")))
            S.client.authorized = True
            S.me = {"name": "Мок Аккаунт", "username": "mock_user"}
            await persist_session()
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
        await finish_login()
    except Exception as e:
        log("login failed:", type(e).__name__)
        L["status"] = "error"


async def finish_login():
    me = await S.client.get_me()
    S.me = {"name": display_name(me), "username": getattr(me, "username", "") or ""}
    await persist_session()
    attach_handlers()
    S.login["status"] = "done"
    log("connected")


async def login_start(_r):
    if S.me:
        return web.json_response({"error": "already_linked"}, status=409)
    if not MOCK and (not API_ID or not API_HASH):
        return web.json_response({"error": "no_api_keys"}, status=503)
    if S.login and S.login.get("task"):
        S.login["task"].cancel()
    if MOCK:
        S.client = MockClient()
        await S.client.connect()
        S.login = {"status": "waiting", "url": "tg://login?token=MOCKTOKEN", "started": time.time()}
    else:
        S.client = telethon_client()
        await S.client.connect()
        qr = await S.client.qr_login()
        S.login = {"status": "waiting", "qr": qr, "url": qr.url, "started": time.time()}
    S.login["task"] = asyncio.create_task(login_task())
    return web.json_response({"url": S.login["url"], "expires_in": 120})


async def login_status(_r):
    L = S.login
    if not L:
        return web.json_response({"status": "none", "linked": S.me is not None, "account": S.me})
    return web.json_response({"status": L["status"], "linked": S.me is not None, "url": L.get("url"), "account": S.me if L["status"] == "done" else None})


async def login_password(r):
    L = S.login
    if not L or L["status"] != "password":
        return web.json_response({"error": "no_login"}, status=409)
    pw = (await r.json()).get("password", "")
    try:
        await S.client.sign_in(password=pw)
    except Exception as e:
        name = type(e).__name__
        return web.json_response({"error": "wrong_password" if "Password" in name else "bridge_error"}, status=400)
    await finish_login()
    return web.json_response({"status": "done", "account": S.me})


async def dialogs(_r):
    if not S.me:
        return web.json_response({"error": "not_linked"}, status=409)
    if MOCK:
        return web.json_response({"dialogs": await S.client.dialogs()})
    out = []
    async for d in S.client.iter_dialogs(limit=150):
        kind = "channel" if d.is_channel and not d.is_group else "group" if d.is_group else "user"
        out.append({"id": d.id, "title": d.name or "?", "type": kind, "unread": d.unread_count})
    return web.json_response({"dialogs": out})


async def set_chats(r):
    """{ chats: [{ id, two_way }] }: exactly these chats are forwarded; everything else is ignored."""
    if not S.me:
        return web.json_response({"error": "not_linked"}, status=409)
    body = await r.json()
    S.allowed = {str(c["id"]): {"two_way": bool(c.get("two_way"))} for c in body.get("chats", [])[:100]}
    save_allowed()
    return web.json_response({"ok": True, "count": len(S.allowed)})


async def send(r):
    if not S.me:
        return web.json_response({"error": "not_linked"}, status=409)
    body = await r.json()
    chat = str(body.get("chat"))
    rule = S.allowed.get(chat)
    if not rule or not rule.get("two_way"):
        return web.json_response({"error": "read_only"}, status=403)
    text = str(body.get("text", ""))[:4000]
    if not text.strip():
        return web.json_response({"error": "empty"}, status=400)
    reply = body.get("reply_to")
    if MOCK:
        mid = await S.client.send(int(chat), text, reply)
    else:
        m = await S.client.send_message(int(chat), text, reply_to=int(reply) if reply else None)
        mid = m.id
    S.sent.append(mid)
    return web.json_response({"tg_msg": mid})


async def logout(_r):
    """End the session on Telegram's side and delete everything kept here."""
    try:
        if S.client:
            if MOCK:
                await S.client.log_out()
            elif await S.client.is_user_authorized():
                await S.client.log_out()
            if not MOCK:
                await S.client.disconnect()
    except Exception as e:
        log("logout:", type(e).__name__)
    await wipe()
    return web.json_response({"ok": True})


async def mock_message(r):
    """Tests only: pretend that a message arrived in Telegram."""
    if not MOCK:
        return web.json_response({"error": "forbidden"}, status=403)
    b = await r.json()
    rule = S.allowed.get(str(b["chat"]))
    if not rule:
        return web.json_response({"forwarded": False})
    await to_server({"tg_chat": str(b["chat"]), "tg_msg": b["msg"], "author": b.get("author", "Кто-то"), "out": bool(b.get("out")),
                     "text": b["text"], "ts": int(time.time() * 1000), "reply_to": None})
    return web.json_response({"forwarded": True})


def app():
    a = web.Application(middlewares=[guard], client_max_size=64 * 1024)
    a.add_routes([
        web.post("/login/start", login_start), web.get("/login/status", login_status), web.post("/login/password", login_password),
        web.get("/dialogs", dialogs), web.post("/chats", set_chats), web.post("/send", send), web.post("/logout", logout),
        web.post("/mock/message", mock_message),
    ])
    return a


async def main():
    if len(TOKEN) < 24:
        raise SystemExit("BRIDGE_TOKEN must be at least 24 characters")
    _key()
    os.makedirs(DATA, exist_ok=True)
    await start_existing()
    # /health is open inside the network so the server can tell whether the service is up (it reveals nothing else)
    app_ = app()
    app_.router.add_get("/health", health)
    runner = web.AppRunner(app_)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log("bridge listening on", PORT, "(mock)" if MOCK else "")
    ticks = 0
    while True:
        await asyncio.sleep(30)
        if S.outbox:
            await flush_outbox()
        ticks += 1
        if ticks % 10 == 0 and S.me and not MOCK:
            # the session may have been ended from the phone (Settings -> Devices): then forget everything
            try:
                if not await S.client.is_user_authorized():
                    log("the session was ended on Telegram's side")
                    await wipe()
            except Exception as e:
                log("session check:", type(e).__name__)


if __name__ == "__main__":
    asyncio.run(main())
