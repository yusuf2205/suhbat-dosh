#!/bin/sh
# Installs the guard on the NAS, once: sudo sh scripts/install-nas-guard.sh   (run in the folder of the app)
# To remove it: sudo systemctl disable --now suhbat-guard.timer
set -e
HERE=$(cd "$(dirname "$0")/.." && pwd)

# every service that is in use starts together, whoever runs "docker compose up" (the guard too); a copy of .env is kept
PROFILES="${PROFILES:-tunnel,watchdog,translate,tgbridge,embed,whisper}"
ENV_FILE="${ENV_FILE:-$HERE/.env}"
set_profiles() {
  [ -f "$ENV_FILE" ] || { echo "No $ENV_FILE"; exit 1; }
  cp -p "$ENV_FILE" "$ENV_FILE.before-guard"
  if grep -q '^COMPOSE_PROFILES=' "$ENV_FILE"; then
    sed -i "s/^COMPOSE_PROFILES=.*/COMPOSE_PROFILES=$PROFILES/" "$ENV_FILE"
  else
    printf 'COMPOSE_PROFILES=%s\n' "$PROFILES" >> "$ENV_FILE"
  fi
}
if [ "${ONLY_PROFILES:-}" = 1 ]; then set_profiles; exit 0; fi

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
set_profiles
grep '^COMPOSE_PROFILES=' "$ENV_FILE"
(cd "$HERE" && docker compose up -d --no-build --no-recreate 2>&1 | tail -3)
install -m 755 "$HERE/scripts/nas-guard.sh" /usr/local/sbin/suhbat-guard
cat > /etc/systemd/system/suhbat-guard.service <<EOF
[Unit]
Description=Suhbat-dosh guard: starts Docker and the messenger after a crash
After=network-online.target

[Service]
Type=oneshot
Environment=APP_DIR=$HERE
ExecStart=/usr/local/sbin/suhbat-guard
EOF
cat > /etc/systemd/system/suhbat-guard.timer <<EOF
[Unit]
Description=Suhbat-dosh guard, every two minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now suhbat-guard.timer
systemctl is-active suhbat-guard.timer
systemctl start suhbat-guard.service || true
journalctl -u suhbat-guard.service -n 3 --no-pager
(cd "$HERE" && docker compose ps --format '{{.Name}} {{.Status}}')
echo "Installed. What it does: journalctl -u suhbat-guard -n 30"
