# Bridge to Telegram accounts

Mirrors Telegram chats into Suhbat-dosh and, per chat, lets the owner answer from here. It runs as a separate container, `tgbridge`, that
logs in to each person's **own** Telegram account as one more device (Telethon, MTProto) by the QR code Telegram shows for a new device.

## How it behaves

* **Who may link:** administrators always; everybody else only if an administrator allowed them (admin panel → *Доступ и рассылка* → *Мост с Телеграмом*).
  Several accounts can be linked side by side, each person has their own. Taking the permission away disconnects that person's session at once.
* **What is copied:** every personal (one-to-one) chat, **by default**, including the recent history (up to 150 messages per chat, once).
  Groups and channels only when the owner picks them. Never copied: Telegram's service chat (it carries login codes), bots, Saved Messages,
  secret chats (Telegram does not expose them to this kind of client).
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

Keep `tgbridge-data/` out of any cloud copy of the NAS, and keep the disk itself encrypted if the device can be stolen.

## Limits

* Text only. Photos, voice, files, stickers show as a mark such as "[Photo]".
* Telegram may restrict an account that behaves like a bot. Normal personal use is far below the limits; the first history copy is paced (about a chat every 0.6 s).
* Messages of people's contacts are stored on your server; they do not know it.

## Testing without Telegram

`TGBRIDGE_MOCK=1` runs fake accounts (see `test/bridge.test.mjs`; set `TGBRIDGE_PYPATH` to a folder with `aiohttp` if Python has none).
