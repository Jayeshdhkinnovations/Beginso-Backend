#!/usr/bin/env bash
# Deploys the backend as a Docker image on THIS server, and rolls back with one command.
#
#   ./scripts/deploy-docker.sh deploy <image-tag>      e.g. ghcr.io/owner/beginso-backend:sha-abc1234
#   ./scripts/deploy-docker.sh rollback                start the previous tag
#   ./scripts/deploy-docker.sh status                  what is running, and its health
#
# deploy: records the running tag as "previous", starts the new tag, waits for the health check, checks that GET / reports the commit the
# tag was built from, and puts the previous tag back by itself if either check fails. With one container behind one proxy the switch is
# a few seconds of refused connections (docker stops the old container, then starts the new one). Zero downtime would need two
# containers behind the proxy; it is not done here because the server runs timers (close expired forms, purge Trash, storage
# reconcile) that have not been shown safe to run twice at once (docs/DOCKER.md).
#
# Needs in this folder: docker-compose.prod.yml and .env. Needs in the environment or in .deploy/env: UPLOADS_PATH, FIREBASE_KEY_PATH.
# It never prints the .env file.
set -euo pipefail

cd "$(dirname "$0")/.."
STATE_DIR=".deploy"
COMPOSE="docker compose -f docker-compose.prod.yml"
HOST_PORT="${HOST_PORT:-5000}"
mkdir -p "$STATE_DIR"
[ -f "$STATE_DIR/env" ] && set -a && . "$STATE_DIR/env" && set +a

current() { [ -f "$STATE_DIR/current" ] && cat "$STATE_DIR/current" || true; }

start() {
  local image="$1"
  BACKEND_IMAGE="$image" $COMPOSE pull --quiet 2>/dev/null || true   # a local image (no registry) is fine
  BACKEND_IMAGE="$image" $COMPOSE up -d --no-build --remove-orphans
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
    old="$(current)"
    echo "deploying $new (previous: ${old:-none})"
    [ -n "$old" ] && echo "$old" > "$STATE_DIR/previous"
    start "$new"
    if verify "$new"; then
      echo "$new" > "$STATE_DIR/current"
      echo "deployed $new"
    else
      echo "the new version failed its checks" >&2
      if [ -n "$old" ]; then echo "putting $old back" >&2; start "$old"; verify "$old" || echo "the previous version is not healthy either: read the logs" >&2; fi
      exit 1
    fi
    ;;
  rollback)
    prev="$( [ -f "$STATE_DIR/previous" ] && cat "$STATE_DIR/previous" || true )"
    [ -n "$prev" ] || { echo "there is no previous version recorded" >&2; exit 1; }
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
    echo "previous: $( [ -f "$STATE_DIR/previous" ] && cat "$STATE_DIR/previous" || true )"
    docker ps --filter name=beginso-backend --format '{{.Names}}  {{.Image}}  {{.Status}}'
    ;;
  *)
    echo "usage: deploy-docker.sh deploy <image-tag> | rollback | status" >&2
    exit 2
    ;;
esac
