# Bridge to Telegram accounts

Mirrors Telegram chats into Suhbat-dosh and, per chat, lets the owner answer from here. It runs as a separate container, `tgbridge`, that
logs in to each person's **own** Telegram account as one more device (Telethon, MTProto) by the QR code Telegram shows for a new device.

## How it behaves

* **Who may link:** everybody, each their own Telegram (several accounts side by side, nothing is shared between people).
  The administrator can forbid a person or remove what they linked (admin panel → *Доступ и рассылка* → *Мост с Телеграмом*): "Запретить" ends that
  person's session at once and keeps the copies; "Удалить" ends it and deletes all the mirrored chats.
* **What is copied:** every personal (one-to-one) chat, **by default**, including the recent history (up to 150 messages per chat, once).
  Groups and channels only when the owner picks them. Never copied: Telegram's service chat (it carries login codes), bots, Saved Messages,
  secret chats (Telegram does not expose them to this kind of client).
* **Personal chats are shown to their owner and can be answered from here** (text; it goes to Telegram from the owner's account).
  An ordinary person cannot delete, clear, leave or edit them, and cannot stop the copying: only the administrator can
  (admin panel → *Мост с Телеграмом*: "Личные чаты: копируются / не копируются"). The person can still switch "answer from here" off per chat
  and fully controls the groups and channels they chose. The person is told all this before linking.
* **Kept in step with Telegram:** new messages arrive at once; edits change the text here; what is deleted in Telegram stays here marked
  "Удалено в Телеграме" (nothing is removed by itself); reading in Telegram marks the chat read here, and reading here marks it read in Telegram
  (only in chats that may be answered from here: a read mark is visible to the other person). After a restart the bridge catches up on what it missed,
  and every 15 minutes it re-checks the newest messages of every personal chat.
* **Quiet:** the mirrored chats are muted and the bridge never triggers a push notification. History arrives already read.
* **Read-only by default.** A chat can be answered from here only after "Answer from here" is switched on for it (text only).
* **Copies are never deleted automatically.** They go only when the owner disconnects and chooses to delete them, or deletes their account.
* **The administrator can read all copies** like any other chat (admin panel → *Чаты и переписка*); every view is written to the journal.
  The person is told this before linking.

## What protects it

| Measure | How |
| --- | --- |
| Session encrypted at rest | AES-256-GCM, key `TGBRIDGE_KEY` from the environment. The key is never in the database, the repository or a backup of the database. |
| No open door | The container publishes no ports; only the `suhbat` container reaches it, and every call needs `BRIDGE_TOKEN` (constant-time check). |
| Hardened container | non-root user, read-only file system, all capabilities dropped, `no-new-privileges`. |
| Key separation | `TGBRIDGE_KEY` and the Telegram API keys live in `.env.bridge`, read by `tgbridge` only; the main server never sees them. |
| No text in logs | Message texts and names are never logged. |
| Real disconnect | "Disconnect" calls Telegram's log-out (the device disappears from Settings → Devices) and deletes the session and the chat list. Deleting an account does the same. |
| You can always revoke | Telegram → Settings → Devices → end the session. The bridge notices within minutes, wipes its files, and the app shows the link as ended. |

## Set up

1. Get `api_id` and `api_hash` at <https://my.telegram.org> → API development tools (free, for your own use).
2. Generate two secrets yourself and put them in two files:

   `.env` (read by `suhbat` and `tgbridge`):
   ```
   BRIDGE_TOKEN=<openssl rand -base64 36>
   ```
   `.env.bridge` (read by `tgbridge` only):
   ```
   TGBRIDGE_KEY=<openssl rand -base64 32>
   TG_API_ID=123456
   TG_API_HASH=0123456789abcdef0123456789abcdef
   ```
3. `docker compose --profile tgbridge up -d --build tgbridge` and restart `suhbat` so it reads `BRIDGE_TOKEN`.
4. In the app: Settings → Data and memory → Bridge with Telegram. Read the notes, tick the box, scan the QR in Telegram
   (Settings → Devices → Link Desktop Device).

Keep the `tgbridge-data` Docker volume out of any cloud copy of the NAS, and keep the disk itself encrypted if the device can be stolen.

## Many accounts

Every linked person is one permanent connection to Telegram inside the `tgbridge` container. What that costs, and what the bridge does about it:

| Matter | How it is handled |
| --- | --- |
| Memory | About 150 MB for the service and 30-50 MB per account. The container is limited to 8 GB (`TGBRIDGE_MEM` in `.env`): plenty for hundreds of accounts. |
| Load on Telegram | Up to ten history copies or light passes run at the same time (`BRIDGE_HEAVY_JOBS`), each person's copy is paced on its own (about a chat every 0.6 s), so ten people can link at the same moment. A restart reconnects accounts one by one, not all at once. |
| Speed | New messages, edits, deletions and read marks arrive as Telegram events, over one shared keep-alive connection to the server, with no queue shared between people (only messages of one chat keep their order). In a test with ten accounts getting twenty messages each at the same moment, a message was readable in the app after 13 ms (median), 95% within 30 ms. A message the server cannot take (it is restarting) is retried every 5 seconds. |
| Keeping in step | New messages come as events. Besides, each account is re-checked about every 5 minutes as a safety net (a few accounts per half minute); the light pass looks only at chats with activity in the last 3 days. |
| Telegram's limits | They apply per Telegram account (each person has their own) and per `api_id`. One `api_id` for a few dozen people is fine; a service with hundreds of accounts under one `api_id` risks being limited by Telegram. If that ever happens, register another application at my.telegram.org and give the bridge a second `api_id`. |
| Who is connected | The administrator panel shows for every person whether the Telegram link is alive ("подключён" / "нет связи"). |
| Groups and channels | Everybody picks their own, one by one (nothing is copied by default), and the administrator sees them all like the personal chats. Choose with care: a busy group of thousands of people is a lot of data. |
| Disk | Text, photos, voice, video, music and files, also from the old history (fetched in the background). Plan for disk space as for a messenger with that many active people; the old history stops being fetched when less than `BRIDGE_MIN_FREE_GB` (5) is left. |

## Limits

* **Copied:** text, photos and voice messages (up to 25 MB each), videos and round videos (`BRIDGE_VIDEO_MAX_MB`, default 200; `BRIDGE_VIDEO=0` switches video off),
  music and documents (`BRIDGE_FILE_MAX_MB`, default 100). Programs and scripts (`.exe`, `.bat`, `.js` ...) are not copied, nor stickers, GIFs, polls: they arrive as a mark such as "[File]".
* **Messages that are only a mark** ("[Photo]", "[File]" ...: the old history, an upload that failed while the server was down) get their file afterwards.
  A pass in the bridge asks the server for them, newest first, a few at a time, and puts the file into the message in place (`BRIDGE_UPGRADE=0` switches it off).
  What cannot be fetched (too big, deleted in Telegram, a blocked type) keeps its mark and is not asked for again (table `tg_media_skip`; empty it to try again after raising a limit).
  A failed upload is also tried again at once (three times); `docker compose logs tgbridge` shows "media upgrade: files added ... to go".
* **Voice messages** are Telegram's Ogg/Opus: Chrome, Edge, Firefox and Android play them; Safari on iPhone may not.
* Telegram may restrict an account that behaves like a bot. Normal personal use is far below the limits; the first history copy is paced (about a chat every 0.6 s).
* Messages of people's contacts are stored on your server; they do not know it.

## Testing without Telegram

`TGBRIDGE_MOCK=1` runs fake accounts (see `test/bridge.test.mjs`; set `TGBRIDGE_PYPATH` to a folder with `aiohttp` if Python has none).
