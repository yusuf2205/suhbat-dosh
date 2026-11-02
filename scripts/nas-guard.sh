#!/bin/sh
# Runs on the NAS itself, outside Docker, every two minutes (scripts/install-nas-guard.sh).
# After a power cut Docker may refuse to start because its list of networks was damaged; nothing inside Docker can repair that.
# This repairs exactly that case and starts what should be running. It never touches the data of the messenger.
set -u

APP_DIR="${APP_DIR:-/home/Joseph/docker/suhbat}"
DOCKER_ROOT="${DOCKER_ROOT:-/volume1/@docker}"
STATE_DIR="${STATE_DIR:-/run/suhbat-guard}"
KV="$DOCKER_ROOT/network/files/local-kv.db"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3000/healthz}"
MAX_REPAIRS="${MAX_REPAIRS:-3}"

mkdir -p "$STATE_DIR"
say() { echo "suhbat-guard: $*"; }

repairs=$(cat "$STATE_DIR/repairs" 2>/dev/null || echo 0)

start_docker() {
  systemctl reset-failed docker.service docker.socket >/dev/null 2>&1
  systemctl start docker.socket docker.service >/dev/null 2>&1
  sleep "${SETTLE:-8}"
  systemctl is-active --quiet docker.service
}

if ! systemctl is-active --quiet docker.service; then
  say "Docker is not running"
  if start_docker; then
    say "Docker started"
  elif journalctl -u docker.service -b --no-pager 2>/dev/null | grep -qE 'invalid freelist page|invalid page type|invalid database'; then
    # the list of networks is only a cache of what Compose creates again; the file is kept beside it, not removed
    if [ "$repairs" -ge "$MAX_REPAIRS" ]; then
      say "giving up after $repairs repairs in this boot: a person must look at this"
      exit 1
    fi
    if [ -f "$KV" ]; then
      echo $((repairs + 1)) > "$STATE_DIR/repairs"
      systemctl stop docker.socket docker.service >/dev/null 2>&1
      mv "$KV" "$KV.broken-$(date +%Y%m%d-%H%M%S)" && say "moved aside the damaged $KV"
      if start_docker; then say "Docker started after the repair"; else say "Docker still does not start"; exit 1; fi
    else
      say "Docker fails, and there is no $KV to repair"
      exit 1
    fi
  else
    say "Docker does not start, for a reason this script does not know"
    exit 1
  fi
fi

# Docker runs: is the messenger there?
cd "$APP_DIR" || exit 1

# containers of ANY project that cannot start because their network is gone (it happens after the repair above): the same containers, reconnected
stale=$(docker ps -a --filter status=exited --format '{{.Names}}' | while read -r c; do
  docker inspect -f '{{.State.Error}}' "$c" 2>/dev/null | grep -q 'network .* not found' && echo "$c"
done)
if [ -n "$stale" ] && [ -f "$APP_DIR/scripts/docker-restore-networks.sh" ]; then
  say "containers lost their network, bringing them back: $(echo "$stale" | wc -l)"
  bash "$APP_DIR/scripts/docker-restore-networks.sh" 2>&1 | tail -5
fi
running=$(docker inspect -f '{{.State.Running}}' suhbat-suhbat-1 2>/dev/null || echo false)
tunnel=$(docker inspect -f '{{.State.Running}}' suhbat-cloudflared-1 2>/dev/null || echo false)
if [ "$running" = true ] && [ "$tunnel" = true ]; then
  rm -f "$STATE_DIR/down"
  exit 0
fi

# give a normal restart or an update time: act only on the second look in a row
if [ ! -f "$STATE_DIR/down" ]; then
  touch "$STATE_DIR/down"
  say "the messenger is not running ($running, tunnel $tunnel): looking again next time"
  exit 0
fi

say "starting the containers"
out=$(docker compose up -d --no-build 2>&1)
status=$?
if [ "$status" -ne 0 ] && echo "$out" | grep -q 'network .* not found'; then
  # containers remember the network from before the repair
  say "recreating the containers: their network is gone"
  docker compose up -d --no-build --force-recreate 2>&1 | tail -3
  status=$?
fi
[ "$status" -eq 0 ] && rm -f "$STATE_DIR/down"
say "done (status $status), health: $(curl -s -m 5 -o /dev/null -w '%{http_code}' "$HEALTH_URL")"
exit "$status"
