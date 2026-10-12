#!/bin/sh
# Stores the Telegram bot token in .env without echoing it, then recreates the container.
# Run on the NAS:  cd /home/Joseph/docker/suhbat && sh scripts/set-telegram-token.sh
set -e
cd "$(dirname "$0")/.."
printf 'Telegram bot token (input hidden): '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'
case "$TOKEN" in
  [0-9]*:*) ;;
  *) echo "That does not look like a bot token (expected 123456:ABC...)."; exit 1 ;;
esac
touch .env && chmod 600 .env
grep -v '^TELEGRAM_BOT_TOKEN=' .env > .env.tmp || true
printf 'TELEGRAM_BOT_TOKEN=%s\n' "$TOKEN" >> .env.tmp
mv .env.tmp .env && chmod 600 .env
docker compose -p suhbat up -d
sleep 5
docker logs suhbat-suhbat-1 2>&1 | grep -E "telegram bot started|telegram" | tail -3
echo "Done. Open the app and press 'Войти через Telegram'."
