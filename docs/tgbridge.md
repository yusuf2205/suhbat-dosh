# Bridge to your own Telegram account

Mirrors chosen Telegram chats into Suhbat-dosh (and, per chat, lets you answer from here). It runs as a separate container, `tgbridge`,
that logs in to **your** Telegram account as one more device (Telethon, MTProto) by the QR code Telegram shows for a new device.

## What protects it

| Measure | How |
| --- | --- |
| Nothing copied by default | Only chats you tick are forwarded; everything else is dropped inside the bridge. |
| Read-only by default | A chat accepts messages from Suhbat-dosh only if "Answer from here" is on for it (checked by the server and again by the bridge). |
| Session encrypted at rest | AES-256-GCM, key `TGBRIDGE_KEY` from the environment. The key is never in the database, the repository or a backup of the database. |
| No open door | The container publishes no ports; only the `suhbat` container reaches it, and every call needs `BRIDGE_TOKEN` (constant-time check). |
| Hardened container | non-root user, read-only file system, all capabilities dropped, `no-new-privileges`. |
| One account | One Telegram account for the whole server. Only an administrator may link it (setting `bridge_access`: `off` / `admins` / `all`). |
| No text in logs | Message texts and names are never logged. |
| Real disconnect | "Disconnect" calls Telegram's log-out (the device disappears from Settings → Devices), deletes the session and the chat list, and can remove the copies. Deleting the account does the same. |
| Retention | "Keep copies: always / 30 / 7 / 1 day" deletes old copies automatically. Nothing is ever deleted in Telegram. |
| You can always revoke | Telegram → Settings → Devices → end the session. The bridge notices within minutes, wipes its files, and the app shows the link as ended. |

## Set up

1. Get `api_id` and `api_hash` at <https://my.telegram.org> → API development tools (free, for your own use).
2. Generate two secrets yourself and put them in two files, so the Telegram key never reaches the main server container:

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
   (Settings → Devices → Link Desktop Device), pick the chats.

Keep `tgbridge-data/` out of any cloud copy of the NAS, and keep the disk itself encrypted if the device can be stolen.

## Limits

* Text only. Photos, voice, files, stickers show as a mark such as "[Photo]".
* Two-way answers go out as plain text from your account.
* Telegram may restrict an account that behaves like a bot. Normal personal use is far below the limits; do not mirror hundreds of busy chats.
* Messages of your contacts are stored on your server; tell people if that matters to them.

## Testing without Telegram

`TGBRIDGE_MOCK=1` runs a fake account (see `test/bridge.test.mjs`).
