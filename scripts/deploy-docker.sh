#!/usr/bin/env bash
# Deploys the backend as a Docker image on THIS server, and rolls back with one command.
#
#   ./scripts/deploy-docker.sh deploy <image-tag>      e.g. ghcr.io/owner/beginso-backend:sha-abc1234
#   ./scripts/deploy-docker.sh rollback                start the previous tag
#   ./scripts/deploy-docker.sh status                  what is running, and its health
#   ./scripts/deploy-docker.sh check                   BEFORE a cutover: other containers, listening ports, free memory (changes nothing)
#   ./scripts/deploy-docker.sh check-port [port]       exit 0 when the port is free (or ours), 3 with a clear message when something else has it
#   ./scripts/deploy-docker.sh cleanup [--dry-run]     remove OUR old images and stopped containers (label com.beginso.app=api), keep the last 5 tags
#
# THIS MACHINE ALSO RUNS OTHER DOCKER CONTAINERS. Everything this script touches is ours and nothing else:
#   - the compose project is fixed (name: beginso-api) and the container is called beginso-api;
#   - everything we create carries the label com.beginso.app=api (image, container, network);
#   - it never runs `docker system prune`, `image prune -a`, `volume prune`, `network prune` or any prune without that label filter;
#   - it never stops or removes a container it did not start, and it never restarts or reinstalls Docker;
#   - before it starts anything it checks that the port is free and, when it is not, STOPS WITH A MESSAGE instead of touching the owner of the port.
#
# deploy: records the running tag as "previous", starts the new tag, waits for the health check, checks that GET / reports the commit the
# tag was built from, and puts the previous tag back by itself if either check fails. With one container behind one proxy the switch is
# a few seconds of refused connections (docker stops the old container, then starts the new one). Zero downtime would need two
# containers behind the proxy; it is not done here because the server runs timers (close expired forms, purge Trash, storage
# reconcile) that have not been shown safe to run twice at once (Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md).
#
# Needs in this folder: docker-compose.prod.yml and .env. Needs in the environment or in .deploy/env: UPLOADS_PATH, FIREBASE_KEY_PATH.
# HOST_PORT (default 5000) is the ONE variable that sets the port; BIND_ADDRESS (default 127.0.0.1) is the ONE variable that sets the address.
# It never prints the .env file.
set -euo pipefail

cd "$(dirname "$0")/.."
STATE_DIR=".deploy"
COMPOSE="docker compose -f docker-compose.prod.yml"
HOST_PORT="${HOST_PORT:-5000}"
CONTAINER="beginso-api"
APP_LABEL="com.beginso.app=api"
KEEP_TAGS=5
MEM_LIMIT_MB=768    # keep in step with mem_limit in docker-compose.prod.yml
BIND_ADDRESS="${BIND_ADDRESS:-127.0.0.1}"   # the address the port is published on; the compose file reads the same variable
mkdir -p "$STATE_DIR"
[ -f "$STATE_DIR/env" ] && set -a && . "$STATE_DIR/env" && set +a

current() { [ -f "$STATE_DIR/current" ] && cat "$STATE_DIR/current" || true; }
previous() { [ -f "$STATE_DIR/previous" ] && cat "$STATE_DIR/previous" || true; }

# ---- the port: never take it from somebody else ---------------------------------------------------------------------------------------

# Prints one line per listener on the port (nothing when it is free).
port_listeners() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH "( sport = :$p )" 2>/dev/null || true
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ltn 2>/dev/null | awk -v want=":$p" '$4 ~ want "$" {print}' || true
  elif (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then
    echo "something accepts connections on port $p"
  fi
}

# True when the port is published by our own running container (it is replaced by the deploy, so it is allowed to hold the port), on any address.
own_port() { docker ps --filter "name=^${CONTAINER}$" --format '{{.Ports}}' 2>/dev/null | grep -qE "(^|[ ,]|:)$1->"; }

check_port() {
  local p="$1" listeners
  case "$p" in ''|*[!0-9]*) echo "HOST_PORT must be a number, it is '$p'" >&2; return 2;; esac
  case "$BIND_ADDRESS" in 127.0.0.1|0.0.0.0) ;; [0-9]*.[0-9]*.[0-9]*.[0-9]*) ;; *) echo "BIND_ADDRESS must be an IPv4 address (127.0.0.1, 0.0.0.0 or this machine's address), it is '$BIND_ADDRESS'" >&2; return 2;; esac
  listeners="$(port_listeners "$p")"
  if [ -n "$listeners" ] && ! own_port "$p"; then
    {
      echo "PORT $p IS ALREADY IN USE by something that is not $CONTAINER:"
      echo "$listeners"
      echo "Nothing was stopped, removed or changed. Choose a free port: run './scripts/deploy-docker.sh check', put HOST_PORT=<free port> in $STATE_DIR/env"
      echo "(and point the proxy at it), then run this again."
    } >&2
    return 3
  fi
  return 0
}

# ---- cleanup: only what carries our label ---------------------------------------------------------------------------------------------

cleanup() {
  local dry="${1:-}" keep_ref n=0 created ref id protected
  protected=" $(current) $(previous) "
  echo "cleanup: only objects labelled $APP_LABEL; keeping the newest $KEEP_TAGS image tags and the current and previous ones"
  # Stopped containers of ours (running ones are never touched).
  if [ "$dry" = "--dry-run" ]; then
    docker ps -a --filter "label=$APP_LABEL" --filter "status=exited" --format '  would remove container {{.Names}}'
  else
    docker container prune --force --filter "label=$APP_LABEL" >/dev/null
  fi
  # Our images, newest first; everything after the first $KEEP_TAGS goes, unless it is the current or the previous one.
  docker image ls --filter "label=$APP_LABEL" --format '{{.CreatedAt}}|{{.Repository}}:{{.Tag}}|{{.ID}}' | sort -r | while IFS='|' read -r created ref id; do
    n=$((n + 1))
    [ "$n" -le "$KEEP_TAGS" ] && continue
    case "$protected" in *" $ref "*) continue;; esac
    case "$ref" in *"<none>"*) ref="$id";; esac
    if [ "$dry" = "--dry-run" ]; then echo "  would remove image $ref"; else docker rmi "$ref" >/dev/null 2>&1 && echo "  removed image $ref" || echo "  kept $ref (in use)"; fi
  done
}

start() {
  local image="$1"
  BACKEND_IMAGE="$image" $COMPOSE pull --quiet 2>/dev/null || true   # a local image (no registry) is fine
  # No --remove-orphans: it would remove containers of the project that this file does not name. We only ever create the one.
  BACKEND_IMAGE="$image" $COMPOSE up -d --no-build
}

# The short commit the tag was built from: the label the image carries, else the part after "sha-" in the tag.
expected_commit() {
  local image="$1" sha
  sha="$(docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image" 2>/dev/null || true)"
  [ -z "$sha" ] && sha="${image##*sha-}"
  echo "${sha:0:7}"
}

verify() {
  local image="$1" want
  want="$(expected_commit "$image")"
  ./scripts/docker-wait.sh "http://127.0.0.1:${HOST_PORT}/api/health" 90 || return 1
  if [ -n "$want" ] && [ "$want" != "unknown" ] && [ "$want" != "local" ]; then
    curl -fsS --max-time 5 "http://127.0.0.1:${HOST_PORT}/" | grep -q "$want" || { echo "the live backend does not report commit $want" >&2; return 1; }
    echo "the live backend reports commit $want"
  fi
}

case "${1:-}" in
  deploy)
    new="${2:?usage: deploy-docker.sh deploy <image-tag>}"
    case "$new" in *:latest|*:) echo "refusing: use a tag per commit, not latest" >&2; exit 2;; esac
    check_port "$HOST_PORT" || exit $?
    [ "$BIND_ADDRESS" = "127.0.0.1" ] || echo "note: port $HOST_PORT is published on $BIND_ADDRESS, so it is reachable from the network (as the pm2 backend is today)."
    old="$(current)"
    echo "deploying $new (previous: ${old:-none})"
    [ -n "$old" ] && echo "$old" > "$STATE_DIR/previous"
    start "$new"
    if verify "$new"; then
      echo "$new" > "$STATE_DIR/current"
      echo "deployed $new"
      cleanup || true   # never fails a deploy that worked
    else
      echo "the new version failed its checks" >&2
      if [ -n "$old" ]; then echo "putting $old back" >&2; start "$old"; verify "$old" || echo "the previous version is not healthy either: read the logs" >&2; fi
      exit 1
    fi
    ;;
  rollback)
    prev="$(previous)"
    [ -n "$prev" ] || { echo "there is no previous version recorded" >&2; exit 1; }
    check_port "$HOST_PORT" || exit $?
    cur="$(current)"
    echo "rolling back to $prev (from ${cur:-unknown})"
    start "$prev"
    verify "$prev"
    echo "$prev" > "$STATE_DIR/current"
    [ -n "$cur" ] && echo "$cur" > "$STATE_DIR/previous"
    echo "rolled back to $prev"
    ;;
  status)
    echo "current:  $(current)"
    echo "previous: $(previous)"
    docker ps --filter "label=$APP_LABEL" --format '{{.Names}}  {{.Image}}  {{.Status}}'
    ;;
  check)
    echo "== Containers on this machine (ours are named $CONTAINER and carry the label $APP_LABEL)"
    docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
    echo
    echo "== Ports in use by listeners (TCP)"
    if command -v ss >/dev/null 2>&1; then ss -ltnH | awk '{print "  " $4}' | sort -u; else netstat -ltn 2>/dev/null | awk 'NR>2 {print "  " $4}' | sort -u; fi
    echo
    echo "== Our port: $HOST_PORT on $BIND_ADDRESS (set HOST_PORT and BIND_ADDRESS in $STATE_DIR/env to change them)"
    check_port "$HOST_PORT" && echo "  free, or held by $CONTAINER itself: ok"
    echo
    echo "== Memory (the container is limited to ${MEM_LIMIT_MB} MB)"
    free -m 2>/dev/null || true
    if [ -r /proc/meminfo ]; then
      avail="$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)"
      if [ "$avail" -lt $((MEM_LIMIT_MB + 512)) ]; then
        echo "  WARNING: only ${avail} MB available, less than the limit plus 512 MB of room for everything else on this machine. Do not cut over yet."
      else
        echo "  ok: ${avail} MB available"
      fi
    fi
    ;;
  check-port)
    check_port "${2:-$HOST_PORT}"
    ;;
  cleanup)
    cleanup "${2:-}"
    ;;
  *)
    echo "usage: deploy-docker.sh deploy <image-tag> | rollback | status | check | check-port [port] | cleanup [--dry-run]" >&2
    exit 2
    ;;
esac
