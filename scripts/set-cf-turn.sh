#!/bin/sh
# Turns on Cloudflare TURN for calls (works through any NAT, no router ports needed) and recreates the container.
# 1) Cloudflare dashboard -> Realtime -> TURN -> create a key; note the "Turn Token ID" and "API token".
# 2) On the NAS:  cd /home/Joseph/docker/suhbat && sh scripts/set-cf-turn.sh
set -e
cd "$(dirname "$0")/.."
printf 'Turn Token ID: '
read -r KEYID
printf 'API token (input hidden): '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'
[ -n "$KEYID" ] && [ -n "$TOKEN" ] || { echo "Both values are required."; exit 1; }
touch .env && chmod 600 .env
grep -v -E '^(CF_TURN_KEY_ID|CF_TURN_API_TOKEN)=' .env > .env.tmp || true
printf 'CF_TURN_KEY_ID=%s\nCF_TURN_API_TOKEN=%s\n' "$KEYID" "$TOKEN" >> .env.tmp
mv .env.tmp .env && chmod 600 .env
docker compose -p suhbat up -d
sleep 6
docker logs suhbat-suhbat-1 2>&1 | grep -i "turn" | tail -3
echo "Done. Admin console -> Server: the TURN status should say 'connected'."
