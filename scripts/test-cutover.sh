#!/usr/bin/env bash
# Tests scripts/cutover.sh with stand-in pm2, docker, rsync, curl and ss commands in a temporary folder: no server, no Docker needed.
# Every path that matters is run: a dry run, a refusal before anything changes, the happy path, and each failure after pm2 is stopped
# (checksum mismatch, deploy fails, jobs not on, port never frees), which must put the old backend back by itself.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
fails=0
ok() { echo "PASS  $1"; }
no() { echo "FAIL  $1"; fails=$((fails + 1)); [ -f "${T:-}/out.txt" ] && { echo "      what the script printed:"; tail -n 12 "$T/out.txt" | sed "s/^/      | /"; echo "      calls:"; tail -n 12 "$T/state/calls" | sed "s/^/      | /"; }; }
check() { if eval "$2"; then ok "$1"; else no "$1"; fi; }

# one fresh fake VM per case: T/deploy (the deploy folder), T/old (the old app), T/bin (the stand-in commands), T/state
fresh() {
  T="$(mktemp -d)"
  mkdir -p "$T/deploy/scripts" "$T/deploy/.deploy" "$T/deploy/secrets" "$T/old/uploads/u1" "$T/bin" "$T/state"
  cp "$ROOT/scripts/cutover.sh" "$T/deploy/scripts/cutover.sh"; chmod +x "$T/deploy/scripts/cutover.sh"
  echo "x" > "$T/deploy/.env"; : > "$T/deploy/docker-compose.prod.yml"; echo "{}" > "$T/deploy/secrets/key.json"
  printf '%s\n' "UPLOADS_PATH=$T/deploy/data-test" "FIREBASE_KEY_PATH=$T/deploy/secrets/key.json" "HOST_PORT=5001" "BIND_ADDRESS=127.0.0.1" "BACKGROUND_JOBS=off" > "$T/deploy/.deploy/env"
  cp "$T/deploy/.deploy/env" "$T/state/env.original"
  echo "a" > "$T/old/uploads/u1/a.txt"; echo "b" > "$T/old/uploads/b.txt"
  echo "online" > "$T/state/pm2"; echo "OLD1234" > "$T/state/commit"; : > "$T/state/calls"
  # --- stand-ins: each one logs its call to state/calls
  cat > "$T/bin/pm2" <<'EOF'
#!/usr/bin/env bash
echo "pm2 $*" >> "$FAKE_STATE/calls"
case "$1" in
  describe) cat "$FAKE_STATE/pm2" ;;
  stop) [ "${PM2_STOP_NOOP:-}" = "1" ] || { echo "stopped" > "$FAKE_STATE/pm2"; echo "none" > "$FAKE_STATE/listener"; } ;;
  start) echo "online" > "$FAKE_STATE/pm2"; echo "OLD1234" > "$FAKE_STATE/commit"; echo "pm2" > "$FAKE_STATE/listener" ;;
esac
exit 0
EOF
  echo "pm2" > "$T/state/listener"
  cat > "$T/bin/ss" <<'EOF'
#!/usr/bin/env bash
case "$(cat "$FAKE_STATE/listener")" in none) ;; *) echo "LISTEN 0 511 *:5000 *:*" ;; esac
EOF
  cat > "$T/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [ "$(cat "$FAKE_STATE/listener")" = "none" ]; then exit 7; fi
echo "{\"message\":\"ok\",\"commit\":\"$(cat "$FAKE_STATE/commit")\"}"
EOF
  cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_STATE/calls"
case "$1 $2" in
  "manifest inspect") [ "${IMAGE_UNREADABLE:-}" = "1" ] && exit 1 ;;
  "logs beginso-api") [ "${JOBS_OFF:-}" = "1" ] && echo "Background jobs are OFF" || echo "Background jobs are ON" ;;
esac
exit 0
EOF
  cat > "$T/bin/rsync" <<'EOF'
#!/usr/bin/env bash
echo "rsync $*" >> "$FAKE_STATE/calls"
src="${@: -2:1}"; dst="${@: -1}"
mkdir -p "$dst"; cp -rp "$src"/. "$dst"/
# the "copy back" direction (volume to old folder) must not corrupt anything
case "$src" in *"/deploy/data/uploads/") ;; *) [ "${RSYNC_CORRUPT:-}" = "1" ] && echo "garbage" > "$dst/b.txt" ;; esac
exit 0
EOF
  # the deploy script of the test: what it was asked, and whether it works
  cat > "$T/deploy/scripts/deploy-docker.sh" <<'EOF'
#!/usr/bin/env bash
echo "deploy-docker $*" >> "$FAKE_STATE/calls"
[ "${DEPLOY_FAIL:-}" = "1" ] && { echo "the new version failed its checks"; exit 1; }
echo "docker-live" > "$FAKE_STATE/listener"; echo "7d26bd9" > "$FAKE_STATE/commit"
exit 0
EOF
  chmod +x "$T"/bin/* "$T/deploy/scripts/deploy-docker.sh"
}

run() { # run <args...>, from the fake deploy folder, with the stand-ins first on PATH
  ( cd "$T/deploy" && FAKE_STATE="$T/state" PATH="$T/bin:$PATH" OLD_APP="$T/old" CUTOVER_ALLOW_NONROOT=1 CUTOVER_PORT_WAIT=2 CUTOVER_HEALTH_WAIT=2 \
    "$T/deploy/scripts/cutover.sh" "$@" ) > "$T/out.txt" 2>&1
  CODE=$?
}
calls() { cat "$T/state/calls"; }
IMG="ghcr.io/jayeshdhkinnovations/beginso-backend:sha-7d26bd9"

echo "== dry run"
fresh; run "$IMG" --dry-run
check "a dry run passes and changes nothing" '[ $CODE -eq 0 ] && ! calls | grep -qE "pm2 (stop|start)|docker rm|rsync|deploy-docker" && [ ! -d "$T/deploy/data" ] && cmp -s "$T/deploy/.deploy/env" "$T/state/env.original"'
check "the dry run says what it would do" 'grep -q "DRY RUN" "$T/out.txt"'

echo "== refusals before anything is changed"
fresh; run "$IMG" --dry-run >/dev/null; IMAGE_UNREADABLE=1 run "$IMG"
check "an unreadable image stops before pm2 is touched" '[ $CODE -ne 0 ] && ! calls | grep -q "pm2 stop" && grep -q "cannot read the image" "$T/out.txt"'
fresh; run "ghcr.io/x/y:latest"
check "a latest tag is refused" '[ $CODE -ne 0 ] && ! calls | grep -q "pm2 stop"'
fresh; echo "stopped" > "$T/state/pm2"; run "$IMG"
check "pm2 not online stops before anything is changed" '[ $CODE -ne 0 ] && ! calls | grep -q "pm2 stop"'
fresh; run
check "no image given is refused" '[ $CODE -ne 0 ] && ! calls | grep -q "pm2 stop"'

echo "== the happy path"
fresh; run "$IMG"
check "it succeeds" '[ $CODE -eq 0 ] && grep -q "DONE" "$T/out.txt"'
check "in the right order: pull, pm2 stop, remove OUR container, copy, deploy" 'calls | grep -nE "docker pull|pm2 stop|docker rm -f beginso-api|rsync -a|deploy-docker deploy" | cut -d: -f2 | awk "{print \$1\$2}" | tr "\n" " " | grep -q "dockerpull pm2stop dockerrm rsync-a deploy-dockerdeploy"'
check "the uploads were copied, identical" 'diff -r "$T/old/uploads" "$T/deploy/data/uploads" >/dev/null'
check "the settings are the live ones" 'grep -q "^HOST_PORT=5000$" "$T/deploy/.deploy/env" && grep -q "^BIND_ADDRESS=0.0.0.0$" "$T/deploy/.deploy/env" && grep -q "^BACKGROUND_JOBS=on$" "$T/deploy/.deploy/env" && grep -q "^UPLOADS_PATH=$T/deploy/data$" "$T/deploy/.deploy/env"'
check "pm2 is stopped, never deleted or restarted" 'grep -q stopped "$T/state/pm2" && ! calls | grep -qE "pm2 (delete|start|restart)"'
check "it only ever removes OUR container, and never prunes" '! calls | grep -E "docker rm" | grep -qv "beginso-api" && ! calls | grep -q prune'
check "a second run while it is running is refused (lock)" 'mkdir "$T/deploy/.deploy/cutover.lock" && { fresh_lock=1; ( cd "$T/deploy" && FAKE_STATE="$T/state" PATH="$T/bin:$PATH" OLD_APP="$T/old" CUTOVER_ALLOW_NONROOT=1 "$T/deploy/scripts/cutover.sh" "$IMG" >/dev/null 2>&1 ); [ $? -ne 0 ]; }'

echo "== a failure after pm2 is stopped puts the old backend back"
rolled_back() { grep -q online "$T/state/pm2" && calls | grep -q "pm2 start" && calls | grep -q "docker rm -f beginso-api" && cmp -s "$T/deploy/.deploy/env" "$T/state/env.original" && [ "$(cat "$T/state/commit")" = "OLD1234" ]; }
fresh; RSYNC_CORRUPT=1 run "$IMG"
check "wrong checksums: rolled back, and the deploy never started" '[ $CODE -ne 0 ] && rolled_back && ! calls | grep -q "deploy-docker deploy" && grep -q "ROLLED BACK" "$T/out.txt"'
fresh; DEPLOY_FAIL=1 run "$IMG"
check "the container fails its checks: rolled back, settings restored" '[ $CODE -ne 0 ] && rolled_back && grep -q "ROLLED BACK" "$T/out.txt"'
fresh; JOBS_OFF=1 run "$IMG"
check "background jobs not ON: rolled back" '[ $CODE -ne 0 ] && rolled_back'
fresh; PM2_STOP_NOOP=1 run "$IMG"
check "the port never frees: rolled back" '[ $CODE -ne 0 ] && calls | grep -q "pm2 start" && grep -q "still in use" "$T/out.txt"'

echo
[ "$fails" -eq 0 ] && echo "ALL CUTOVER CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit "$fails"
