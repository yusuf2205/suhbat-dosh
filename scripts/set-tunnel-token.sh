#!/bin/sh
# Connects this server to its own Cloudflare Tunnel (public access via your domain, no port forwarding).
# The token is read without echo, stored in .env (mode 600) and never printed.
# Run on the NAS:  cd /home/Joseph/docker/suhbat && sh scripts/set-tunnel-token.sh
set -e
cd "$(dirname "$0")/.."
printf 'Cloudflare Tunnel token (input hidden): '
stty -echo 2>/dev/null || true
read -r TOKEN
stty echo 2>/dev/null || true
printf '\n'
case "$TOKEN" in
  eyJ*) ;;
  *) echo "That does not look like a tunnel token (it should start with eyJ...)."; exit 1 ;;
esac
touch .env && chmod 600 .env
grep -v -E '^(CLOUDFLARE_TUNNEL_TOKEN|COMPOSE_PROFILES|TRUST_PROXY)=' .env > .env.tmp || true
{
  printf 'CLOUDFLARE_TUNNEL_TOKEN=%s\n' "$TOKEN"
  printf 'COMPOSE_PROFILES=tunnel\n'
  printf 'TRUST_PROXY=true\n'
} >> .env.tmp
mv .env.tmp .env && chmod 600 .env
docker compose -p suhbat up -d
sleep 8
echo "--- tunnel status"
docker logs suhbat-cloudflared-1 2>&1 | grep -E "Registered tunnel connection|ERR|error" | tail -4 || true
echo "Next: in Cloudflare add a Public Hostname -> your domain -> HTTP -> suhbat:3000"
