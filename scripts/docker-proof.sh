#!/usr/bin/env bash
# Proves the Docker image on a machine that has Docker. Nothing here touches a server; it builds, runs and throws everything away.
#   ./scripts/docker-proof.sh            builds from scratch (no cache) and runs every check
# Each check prints PASS or FAIL; the script exits non-zero when any fails. The same checks (except 1, 5 and 8) run in CI (job `docker`).
set -uo pipefail
cd "$(dirname "$0")/.."

IMAGE="beginso-api:proof"
NET="beginso-api-proof-net"
PORT="${PROOF_PORT:-55000}"   # the one variable for the one published port (always on 127.0.0.1)
LABEL="com.beginso.app=api"
fails=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; fails=$((fails + 1)); }
check() { local name="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
cleanup() { docker rm -f beginso-api-proof beginso-api-proof-mongo >/dev/null 2>&1; docker volume rm -f beginso-api-proof-data >/dev/null 2>&1; docker network rm "$NET" >/dev/null 2>&1; }
trap cleanup EXIT
cleanup
# Another container on this machine may already hold the port: stop here with a clear message, touching nothing.
HOST_PORT="$PORT" ./scripts/deploy-docker.sh check-port || exit $?

echo "== 1. Fresh build, no cache"
start=$SECONDS
docker build --no-cache --build-arg GIT_SHA="$(git rev-parse HEAD)" --build-arg BUILD_TIME="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -t "$IMAGE" . && pass "image builds from scratch in $((SECONDS - start)) s" || { fail "image build"; exit 1; }
docker image ls "$IMAGE" --format 'image size: {{.Size}}'

echo "== 6. Non-root user"
[ "$(docker run --rm --entrypoint id "$IMAGE" -u)" != "0" ] && pass "runs as a non-root user" || fail "runs as root"

echo "== 3. Missing required variable: exits with a clear message (name only)"
out="$(docker run --rm -e NODE_ENV=production "$IMAGE" 2>&1)"; code=$?
[ "$code" -ne 0 ] && echo "$out" | grep -q "JWT_SECRET is missing" && pass "exit $code and the message names JWT_SECRET" || fail "missing variable was not refused"

echo "== 7. No secret in the image"
docker history --no-trunc "$IMAGE" > /tmp/proof-history.txt; docker inspect "$IMAGE" > /tmp/proof-inspect.txt
if grep -E '(JWT_SECRET|MONGODB_URI|SMTP_PASS|PROXY_SHARED_SECRET|AUTH_EMAIL_HASH_PEPPER|DKIM_PRIVATE_KEY|SUPER_ADMIN_PASSWORD)=[^ ]' /tmp/proof-history.txt /tmp/proof-inspect.txt >/dev/null; then fail "a secret name with a value is in the history or the inspect output"; else pass "no secret name with a value in docker history or docker inspect"; fi
docker run --rm --entrypoint sh "$IMAGE" -c 'find / -name "serviceAccountKey*.json" -not -path "/proc/*" 2>/dev/null | grep .' >/dev/null && fail "a Firebase key file is in the image" || pass "no Firebase key file in the image"

echo "== 2. Starts with only environment variables; the health route reports the commit"
docker network create --label "$LABEL" "$NET" >/dev/null
docker run -d --label "$LABEL" --name beginso-api-proof-mongo --network "$NET" mongo:7 >/dev/null
docker volume create --label "$LABEL" beginso-api-proof-data >/dev/null
docker run --rm -v beginso-api-proof-data:/data --user 0 --entrypoint sh "$IMAGE" -c 'chown -R node:node /data' >/dev/null
docker run -d --label "$LABEL" --name beginso-api-proof --network "$NET" -p 127.0.0.1:${PORT}:5000 -v beginso-api-proof-data:/data \
  -e NODE_ENV=development -e MONGODB_URI=mongodb://beginso-api-proof-mongo:27017/proof -e JWT_SECRET=proof-only -e PROXY_SHARED_SECRET=proof-only \
  -e APP_URL=http://localhost:3000 -e TRUST_PROXY_HOPS=0 "$IMAGE" >/dev/null
./scripts/docker-wait.sh http://127.0.0.1:${PORT}/api/health 90 && pass "health answers 200" || { fail "health"; docker logs beginso-api-proof; }
short="$(git rev-parse HEAD | cut -c1-7)"
curl -fsS http://127.0.0.1:${PORT}/api/health | grep -q "$short" && pass "health reports commit $short" || fail "health does not report commit $short"
curl -fsS http://127.0.0.1:${PORT}/ | grep -q "$short" && pass "GET / reports commit $short (the line the deploy greps)" || fail "GET / does not report the commit"

echo "== 4. Uploads survive a new container"
docker exec beginso-api-proof sh -c 'echo proof > /data/uploads/proof.txt'
docker rm -f beginso-api-proof >/dev/null
docker run -d --label "$LABEL" --name beginso-api-proof --network "$NET" -v beginso-api-proof-data:/data -e NODE_ENV=development -e MONGODB_URI=mongodb://beginso-api-proof-mongo:27017/proof -e JWT_SECRET=proof-only "$IMAGE" >/dev/null
sleep 5
docker exec beginso-api-proof cat /data/uploads/proof.txt | grep -q proof && pass "the file is still there after the container was recreated" || fail "the file was lost"

echo "== 5. Graceful stop"
start=$SECONDS
docker stop -t 30 beginso-api-proof >/dev/null
[ "$(docker inspect beginso-api-proof --format '{{.State.ExitCode}}')" = "0" ] && pass "exit code 0 after $((SECONDS - start)) s" || fail "stop was not clean"
echo "   (a request that is still running is allowed to finish: see src/__tests__/docker_runtime.test.ts)"

echo "== 6b. Read-only root filesystem (as in docker-compose.prod.yml) still works"
docker run -d --label "$LABEL" --name beginso-api-proof --network "$NET" --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges:true -v beginso-api-proof-data:/data \
  -e NODE_ENV=development -e MONGODB_URI=mongodb://beginso-api-proof-mongo:27017/proof -e JWT_SECRET=proof-only -p 127.0.0.1:${PORT}:5000 "$IMAGE" >/dev/null
./scripts/docker-wait.sh http://127.0.0.1:${PORT}/api/health 90 && pass "healthy with a read-only root, no capabilities and no new privileges" || { fail "read-only root"; docker logs beginso-api-proof; }
docker exec beginso-api-proof sh -c 'touch /app/should-fail' >/dev/null 2>&1 && fail "the code folder is writable" || pass "the code folder is not writable"
docker exec beginso-api-proof sh -c 'touch /data/uploads/ok && rm /data/uploads/ok' >/dev/null 2>&1 && pass "the data volume is writable" || fail "the data volume is not writable"

echo "== 9. A report PDF and a CSV can be written to the data volume"
docker exec beginso-api-proof node -e "const PDFDocument=require('/app/node_modules/pdfkit');const fs=require('fs');const d=new PDFDocument();const s=fs.createWriteStream('/data/uploads/proof.pdf');d.pipe(s);d.text('proof');d.end();s.on('finish',()=>{fs.writeFileSync('/data/uploads/proof.csv','a,b\n1,2\n');console.log('ok')})" | grep -q ok && pass "pdfkit wrote a PDF and a CSV under /data/uploads" || fail "pdf/csv"

echo
[ "$fails" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "$fails CHECK(S) FAILED"
exit "$fails"
