# Alerts

The administrators get a message in the messenger (from "Suhbat-dosh") and, if they signed in with the Telegram bot, in Telegram too, when:

* the site stops answering from outside (the server opens `PUBLIC_URL/healthz` through the tunnel once a minute; three misses in a row = an alert, and another when it is back);
* the Telegram bridge container stops answering;
* the server itself was off for more than five minutes (power cut, the NAS restarted, a crash), found by the heartbeat it writes every minute;
* the disk is nearly full, or the number of server errors jumps;
* a database copy did not reach the second disk, or the daily check of the newest copy failed.

Set `PUBLIC_URL` in `.env` (for example `https://suhbat-dosh.uz`) to switch the outside check on.

## Self-healing after a reboot or a crash

Docker's `restart: unless-stopped` does not try again when a container's start itself failed (for example a bind mount that was not ready yet after a reboot).
The `watchdog` service (switch it on with `COMPOSE_PROFILES=...,watchdog`) checks every 30 seconds and starts again any of `suhbat tgbridge cloudflared whisper embed`
(`WATCHDOG_SERVICES` in `.env`) that is not running. `docker logs <project>-watchdog-1` says what it did.
To stop a service on purpose (maintenance), stop the watchdog first: `docker compose stop watchdog`.

Nothing inside the server can warn you when the server itself is down: for that, point a free outside monitor (UptimeRobot, Better Stack) at `https://your-address/healthz`.
