#!/bin/bash
# After Docker lost its list of networks, every container that was running fails with "network ... not found".
# This brings them back as they were: the networks come from each project's own compose file (so isolated networks stay isolated),
# and the same containers are reconnected and started. Nothing is recreated or rebuilt, no volume is touched.
#   DRY_RUN=1 bash scripts/docker-restore-networks.sh    only tells what it would do
#   ONLY="name other" bash ...                           only these containers
set -u
DRY="${DRY_RUN:-}"
ONLY="${ONLY:-}"
run() { if [ -n "$DRY" ]; then echo "  would run: $*"; else "$@"; fi; }
lab() { docker inspect -f "{{index .Config.Labels \"$2\"}}" "$1" 2>/dev/null; }

# what was running when Docker went down, and cannot start now
mapfile -t ALL < <(docker ps -a --filter status=exited --format '{{.Names}}|{{.Status}}' | grep -E '\|Exited \(255\)' | cut -d'|' -f1)
TARGETS=()
for c in "${ALL[@]}"; do
  if [ -z "$ONLY" ] || [[ " $ONLY " == *" $c "* ]]; then TARGETS+=("$c"); fi
done
echo "containers to bring back: ${#TARGETS[@]}"
[ "${#TARGETS[@]}" -gt 0 ] || exit 0

# 1. networks of compose projects, exactly as their files describe them
declare -A DONE
for c in "${TARGETS[@]}"; do
  p=$(lab "$c" com.docker.compose.project)
  [ -n "$p" ] && [ -z "${DONE[$p]:-}" ] || continue
  DONE[$p]=1
  dir=$(lab "$c" com.docker.compose.project.working_dir)
  files=$(lab "$c" com.docker.compose.project.config_files)
  envs=$(lab "$c" com.docker.compose.project.environment_file)
  if [ ! -d "$dir" ]; then echo "! project $p: folder $dir is gone, its networks will be plain ones"; continue; fi
  args=(-p "$p" --project-directory "$dir")
  ok=1
  IFS=',' read -ra FS <<< "$files"
  for f in "${FS[@]}"; do [ -f "$f" ] && args+=(-f "$f") || { echo "! project $p: no file $f"; ok=0; }; done
  IFS=',' read -ra ES <<< "$envs"
  for e in "${ES[@]}"; do [ -n "$e" ] && [ -f "$e" ] && args+=(--env-file "$e"); done
  [ "$ok" = 1 ] || continue
  # the networks each container of this project needs, by the short name used in the file
  nets=$(docker compose "${args[@]}" config --format json 2>/dev/null | python3 -c '
import json, sys
try:
    c = json.load(sys.stdin)
except Exception:
    sys.exit(0)
for key, n in (c.get("networks") or {}).items():
    if n.get("external"):
        continue
    opts = ["--driver", n.get("driver") or "bridge"]
    if n.get("internal"):
        opts.append("--internal")
    if n.get("enable_ipv6") or n.get("enable_ipv6") == "true":
        opts.append("--ipv6")
    for s in ((n.get("ipam") or {}).get("config") or []):
        if s.get("subnet"): opts += ["--subnet", s["subnet"]]
        if s.get("gateway"): opts += ["--gateway", s["gateway"]]
    for k, v in (n.get("driver_opts") or {}).items():
        opts += ["--opt", f"{k}={v}"]
    print(n.get("name") or key, key, " ".join(opts))
')
  if [ -z "$nets" ]; then echo "! project $p: could not read its compose file"; continue; fi
  while read -r name key opts; do
    docker network inspect "$name" >/dev/null 2>&1 && continue
    echo "project $p: network $name ($opts)"
    # shellcheck disable=SC2086
    run docker network create $opts --label "com.docker.compose.network=$key" --label "com.docker.compose.project=$p" "$name" >/dev/null
  done <<< "$nets"
done

# 2. every network a container still asks for and no compose file described
for c in "${TARGETS[@]}"; do
  p=$(lab "$c" com.docker.compose.project)
  while IFS='|' read -r n ip; do
    [ -z "$n" ] || [ "$n" = bridge ] || [ "$n" = host ] || [ "$n" = none ] && continue
    docker network inspect "$n" >/dev/null 2>&1 && continue
    [[ " ${MADE:-} " == *" $n "* ]] && continue
    MADE="${MADE:-} $n"
    opts=()
    # a fixed address needs its network to contain it
    [[ "$ip" =~ ^([0-9]+\.[0-9]+\.[0-9]+)\.[0-9]+$ ]] && opts+=(--subnet "${BASH_REMATCH[1]}.0/24")
    # so that "docker compose up" later takes it for its own
    if [ -n "$p" ] && [[ "$n" == "${p}_"* ]]; then opts+=(--label "com.docker.compose.network=${n#"${p}_"}" --label "com.docker.compose.project=$p"); fi
    echo "network $n: ordinary, from the container's own settings ${opts[*]:-}"
    run docker network create "${opts[@]}" "$n" >/dev/null
  done < <(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{$n}}|{{if $v.IPAMConfig}}{{$v.IPAMConfig.IPv4Address}}{{end}}{{"\n"}}{{end}}' "$c")
done

# 3. the same containers, on the new networks
for c in "${TARGETS[@]}"; do
  while IFS='|' read -r n ip aliases; do
    [ -z "$n" ] || [ "$n" = host ] || [ "$n" = none ] && continue
    [ "$n" = bridge ] && { run docker network disconnect -f bridge "$c" 2>/dev/null; run docker network connect bridge "$c"; continue; }
    args=()
    for a in ${aliases//,/ }; do args+=(--alias "$a"); done
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && args+=(--ip "$ip")
    run docker network disconnect -f "$n" "$c" || echo "! $c: could not disconnect $n"
    run docker network connect "${args[@]}" "$n" "$c" || echo "! $c: could not connect $n"
  done < <(docker inspect -f '{{range $n, $v := .NetworkSettings.Networks}}{{$n}}|{{if $v.IPAMConfig}}{{$v.IPAMConfig.IPv4Address}}{{end}}|{{range $v.Aliases}}{{.}},{{end}}{{"\n"}}{{end}}' "$c")
done

# 4. start: storage first, so that the others find it
FIRST=(); REST=()
for c in "${TARGETS[@]}"; do
  if [[ "$c" =~ (postgres|-db|db-1|redis|minio|mysql) ]]; then FIRST+=("$c"); else REST+=("$c"); fi
done
for c in "${FIRST[@]}"; do run docker start "$c" >/dev/null || echo "! $c did not start"; done
[ -z "$DRY" ] && [ "${#FIRST[@]}" -gt 0 ] && sleep 10
for c in "${REST[@]}"; do run docker start "$c" >/dev/null || echo "! $c did not start"; done
[ -z "$DRY" ] && sleep 8
echo "still not running:"
docker ps -a --filter status=exited --format '{{.Names}} {{.Status}}' | grep -E 'Exited \(255\)' || echo "  none"
