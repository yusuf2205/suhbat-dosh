#!/usr/bin/env bash
# The whole way of putting a change live, with the checks in front of it and behind it:
#   1. all tests (server, bridge and the screens in a real browser): a failure stops everything
#   2. the files go to the NAS and the container is rebuilt (add --bridge to rebuild the Telegram bridge too)
#   3. wait until the site answers, then look at it from the outside (scripts/smoke-prod.mjs): pages, every script, styles, API, live connection
#   4. push to GitHub
# Usage: scripts/deploy.sh [--bridge] [--skip-tests]
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${DEPLOY_HOST:-Joseph@100.126.164.29}"
DIR="${DEPLOY_DIR:-/home/Joseph/docker/suhbat}"
URL="${SMOKE_URL:-https://suhbat-dosh.uz}"
BRIDGE=0
TESTS=1
for a in "$@"; do
  case "$a" in
    --bridge) BRIDGE=1 ;;
    --skip-tests) TESTS=0 ;;
    *) echo "unknown option $a"; exit 2 ;;
  esac
done

if [ "$TESTS" = 1 ]; then
  echo "== tests"
  npm test
fi

echo "== to the NAS"
REMOTE="cd $DIR && tar xf - && docker compose up -d --build suhbat"
if [ "$BRIDGE" = 1 ]; then
  REMOTE="$REMOTE && docker compose --profile tgbridge up -d --build tgbridge"
fi
tar cf - web server shared docs tgbridge nllb Dockerfile docker-compose.yml .env.example scripts | ssh "$HOST" "$REMOTE"

echo "== waiting for the site"
ok=0
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w "%{http_code}" "$URL/healthz" || true)
  if [ "$code" = 200 ]; then ok=1; break; fi
  sleep 3
done
if [ "$ok" != 1 ]; then echo "the site does not answer after the deploy"; exit 1; fi

echo "== the site from the outside"
node scripts/smoke-prod.mjs "$URL"

echo "== GitHub"
git push github main
echo "done"
