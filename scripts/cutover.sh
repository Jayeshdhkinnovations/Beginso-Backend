#!/usr/bin/env bash
# The ONE-TIME cutover of the live backend from pm2 to the Docker container, on THIS VM, as one command, with an automatic way back.
#
#   ./scripts/cutover.sh <image> --dry-run     reads and checks everything, prints the plan, changes NOTHING (run this first, any time)
#   ./scripts/cutover.sh <image>               the real thing: a few minutes of downtime, from "pm2 stop" until the container answers
#
#   <image> is the full name with a tag per commit, for example ghcr.io/jayeshdhkinnovations/beginso-backend:sha-7d26bd9
#
# Run it as root from /opt/beginso-backend, after Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md sections 3 to 5 (folders, .env, key, .deploy/env, the registry login, the test
# container). It is the "real cutover" of section 7 in one script. In order:
#   1. checks (nothing is changed yet): the image can be read, the files are there, pm2 is serving, the uploads folder exists
#   2. pulls the image (so the downtime is short)
#   3. stops the pm2 backend and waits for port 5000 to be free            <- downtime starts here
#   4. removes our test container (beginso-api, by name; nothing else)
#   5. copies the uploads into the volume and checks file count AND checksums
#   6. switches .deploy/env to the live settings (data folder, port 5000, all addresses, background jobs ON), then runs scripts/deploy-docker.sh
#   7. checks the container reports the right commit and that its background jobs are ON
# If ANY step from 3 on fails it puts the pm2 backend back by itself (stops our container, restores the settings, copies newer uploads back,
# starts pm2, waits until the old commit answers) and exits 1. pm2 is never deleted; the old uploads folder is never touched except for that copy back.
set -uo pipefail

cd "$(dirname "$0")/.."
DEPLOY_DIR="$(pwd)"
OLD_APP="${OLD_APP:-/root/Onboarding-backend}"
PM2_NAME="${PM2_NAME:-onboarding-backend}"
LIVE_PORT="${LIVE_PORT:-5000}"
PORT_WAIT="${CUTOVER_PORT_WAIT:-30}"
HEALTH_WAIT="${CUTOVER_HEALTH_WAIT:-60}"
DEPLOY_SCRIPT="${DEPLOY_SCRIPT:-./scripts/deploy-docker.sh}"
CONTAINER="beginso-api"
STATE=".deploy"

IMAGE=""; DRY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    -*) echo "unknown option $arg" >&2; exit 2 ;;
    *) IMAGE="$arg" ;;
  esac
done

mkdir -p "$STATE"
LOG="$STATE/cutover-$(date +%Y%m%d-%H%M%S).log"
log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }

STOPPED=""   # set once pm2 is stopped: from then on a failure rolls back
TMP="$(mktemp -d)"
LOCK="$STATE/cutover.lock"
cleanup_exit() { rm -rf "$TMP"; [ -n "${HAVE_LOCK:-}" ] && rmdir "$LOCK" 2>/dev/null; }
trap cleanup_exit EXIT

die() { log "STOP: $*"; exit 1; }

live_commit() { curl -s -m 5 "http://127.0.0.1:${LIVE_PORT}/" | sed -n 's/.*"commit":"\([^"]*\)".*/\1/p'; }
port_busy() { ss -ltnH "( sport = :${LIVE_PORT} )" 2>/dev/null | grep -q .; }
wait_for() { # wait_for <seconds> <command...>
  local n="$1"; shift
  while [ "$n" -gt 0 ]; do "$@" && return 0; sleep 1; n=$((n - 1)); done
  "$@"
}
port_free() { ! port_busy; }
old_answers() { [ "$(live_commit)" = "$OLD_COMMIT" ]; }
set_kv() { # set_kv KEY VALUE in .deploy/env
  if grep -q "^$1=" "$STATE/env"; then sed -i "s#^$1=.*#$1=$2#" "$STATE/env"; else echo "$1=$2" >> "$STATE/env"; fi
}

rollback() {
  log "ROLLING BACK to the pm2 backend (the old version)"
  docker rm -f "$CONTAINER" >/dev/null 2>&1
  [ -f "$STATE/env.before-cutover" ] && cp "$STATE/env.before-cutover" "$STATE/env"
  # anything the container may have written meanwhile goes back, only newer files, nothing is overwritten or deleted
  if [ -d "$DEPLOY_DIR/data/uploads" ]; then
    rsync -rlt --update --no-owner --no-group "$DEPLOY_DIR/data/uploads/" "$OLD_APP/uploads/" >>"$LOG" 2>&1 \
      || log "WARNING: copying the uploads back failed: do it by hand (Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md section 9, step 2)"
  fi
  pm2 start "$PM2_NAME" >>"$LOG" 2>&1
  if wait_for "$HEALTH_WAIT" old_answers; then
    log "ROLLED BACK: the old backend (commit $OLD_COMMIT) answers on port $LIVE_PORT again. Nothing was lost. Read $LOG, fix the cause, run again."
  else
    log "ROLLBACK DID NOT RESTORE THE OLD BACKEND: run 'pm2 start $PM2_NAME' by hand and check 'pm2 logs'. Read $LOG."
  fi
}
fail() { log "FAILED: $*"; [ -n "$STOPPED" ] && rollback; exit 1; }

# ---------------------------------------------------------------- 1. checks: nothing is changed
[ "${CUTOVER_ALLOW_NONROOT:-}" = "1" ] || [ "$(id -u)" = "0" ] || die "run as root (pm2 and $OLD_APP belong to root)"
[ -n "$IMAGE" ] || die "usage: cutover.sh <image> [--dry-run]   e.g. ghcr.io/jayeshdhkinnovations/beginso-backend:sha-7d26bd9"
case "$IMAGE" in *:latest|*:|*[[:space:]]*) die "use an image with a tag per commit, not latest" ;; esac
for c in pm2 docker rsync curl sha256sum ss; do command -v "$c" >/dev/null 2>&1 || die "'$c' is not installed"; done
[ -f .env ] || die "$DEPLOY_DIR/.env is missing (Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md section 3)"
[ -f docker-compose.prod.yml ] && [ -x "$DEPLOY_SCRIPT" ] || die "docker-compose.prod.yml or $DEPLOY_SCRIPT is missing"
[ -f "$STATE/env" ] || die "$STATE/env is missing (Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md section 3, step 5)"
KEY="$(sed -n 's/^FIREBASE_KEY_PATH=//p' "$STATE/env")"
[ -f "$KEY" ] || die "the Firebase key file is missing at '$KEY'"
[ -d "$OLD_APP/uploads" ] || die "the old uploads folder is missing: $OLD_APP/uploads"
pm2 describe "$PM2_NAME" 2>/dev/null | grep -q online || die "pm2 does not show $PM2_NAME as online: nothing to switch from (or it is already stopped)"
OLD_COMMIT="$(live_commit)"
[ -n "$OLD_COMMIT" ] || die "the pm2 backend does not answer on port $LIVE_PORT, so a rollback could not be checked"
docker manifest inspect "$IMAGE" >/dev/null 2>&1 || die "cannot read the image $IMAGE (wrong tag, or 'docker login ghcr.io' is missing)"
WANT="${IMAGE##*sha-}"; WANT="${WANT:0:7}"
if [ -z "$DRY" ]; then
  mkdir "$LOCK" 2>/dev/null || die "another cutover is running, or a failed one left $LOCK (remove it only when you are sure none is running)"
  HAVE_LOCK=1
fi
FILES_OLD="$(find "$OLD_APP/uploads" -type f | wc -l | tr -d ' ')"
log "image:        $IMAGE (expects commit $WANT)"
log "old backend:  pm2 '$PM2_NAME', commit $OLD_COMMIT, answering on port $LIVE_PORT"
log "uploads:      $FILES_OLD files in $OLD_APP/uploads"
log "other containers are never touched; only '$CONTAINER' (ours) is removed and re-created"

if [ -n "$DRY" ]; then
  log "DRY RUN: every check above passed. A real run would now: pull the image, stop pm2, remove the test container, copy the $FILES_OLD uploads and verify them,"
  log "          switch $STATE/env to port $LIVE_PORT on 0.0.0.0 with background jobs ON, start the container and check it. Nothing was changed."
  exit 0
fi

# ---------------------------------------------------------------- 2. pull first, so the downtime is short
log "pulling the image"
docker pull -q "$IMAGE" >>"$LOG" 2>&1 || die "docker pull failed (nothing was changed)"

# ---------------------------------------------------------------- 3. stop pm2: the downtime starts here
log "stopping the pm2 backend (the site is down from now on)"
cp "$STATE/env" "$STATE/env.before-cutover"
STOPPED=1
pm2 stop "$PM2_NAME" >>"$LOG" 2>&1 || fail "pm2 stop failed"
wait_for "$PORT_WAIT" port_free || fail "port $LIVE_PORT is still in use after pm2 stopped"

# ---------------------------------------------------------------- 4. our test container goes (by name only)
docker rm -f "$CONTAINER" >>"$LOG" 2>&1

# ---------------------------------------------------------------- 5. the uploads, verified
log "copying the uploads into the volume"
mkdir -p "$DEPLOY_DIR/data/uploads"
rsync -a "$OLD_APP/uploads/" "$DEPLOY_DIR/data/uploads/" >>"$LOG" 2>&1 || fail "the uploads copy failed"
chown -R 1000:1000 "$DEPLOY_DIR/data" >>"$LOG" 2>&1 || fail "chown of the data folder failed"
FILES_NEW="$(find "$DEPLOY_DIR/data/uploads" -type f | wc -l | tr -d ' ')"
[ "$FILES_OLD" = "$FILES_NEW" ] || fail "file count differs: $FILES_OLD in the old folder, $FILES_NEW in the volume"
(cd "$OLD_APP/uploads" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$TMP/before.sha"
(cd "$DEPLOY_DIR/data/uploads" && find . -type f -print0 | sort -z | xargs -0 -r sha256sum) > "$TMP/after.sha"
cmp -s "$TMP/before.sha" "$TMP/after.sha" || fail "the checksums of the copy do not match the originals"
log "uploads verified: $FILES_NEW files, identical checksums"

# ---------------------------------------------------------------- 6. the live settings, then the normal deploy
set_kv UPLOADS_PATH "$DEPLOY_DIR/data"
set_kv HOST_PORT "$LIVE_PORT"
set_kv BIND_ADDRESS "0.0.0.0"
set_kv BACKGROUND_JOBS "on"
log "starting the container on port $LIVE_PORT"
"$DEPLOY_SCRIPT" deploy "$IMAGE" >>"$LOG" 2>&1 || fail "the container did not pass its health and commit checks (see $LOG)"

# ---------------------------------------------------------------- 7. what the deploy script does not check
[ "$(live_commit)" = "$WANT" ] || fail "port $LIVE_PORT does not report commit $WANT"
docker logs "$CONTAINER" 2>&1 | grep -q "Background jobs are ON" || fail "the container's background jobs are not ON"

log "DONE. The backend now runs in Docker (commit $WANT) on port $LIVE_PORT; pm2 '$PM2_NAME' is stopped, not deleted."
log "Next: open the site, sign in, open a form and a file, export a PDF; watch 'docker logs -f $CONTAINER' for ten minutes."
log "Do NOT run 'pm2 start $PM2_NAME' while the container is live. To go back: Beginso-Report/Beginso-Backend-Report/docs/DOCKER.md section 9."
