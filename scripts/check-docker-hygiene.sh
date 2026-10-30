#!/usr/bin/env bash
# The VM that runs this backend also runs other Docker containers that must never be touched. This check fails when a script, workflow or compose
# file of ours could affect anything that is not ours. It runs in CI (job `docker`) and can be run by hand: ./scripts/check-docker-hygiene.sh
#
#   1. no `docker ... prune` command without our label filter (--filter label=com.beginso.app=api), and none that can remove volumes or networks at all;
#   2. no `docker system prune`, `image prune -a`, `volume prune`, `network prune` or `builder prune` anywhere;
#   3. no command that stops, kills, removes or restarts "all containers" ($(docker ps -q) and the like), and none that restarts the Docker daemon;
#   4. both compose files fix the project name with a beginso-api prefix, and every published port is bound to 127.0.0.1.
# Documentation (docs/*.md) is not scanned: it says what NOT to run.
set -u
cd "$(dirname "$0")/.."
fail=0
bad() { echo "HYGIENE: $1" >&2; fail=1; }

files="$(git ls-files 'scripts/*' '.github/workflows/*' 'docker-compose*.yml' 'Dockerfile' 'docker/*' 2>/dev/null | grep -v 'check-docker-hygiene.sh')"

while IFS= read -r line; do
  [ -z "$line" ] && continue
  case "$line" in *"label=com.beginso.app=api"*|*'label=$APP_LABEL'*) ;; *) bad "an unfiltered prune: $line";; esac
  case "$line" in *"system prune"*|*"volume prune"*|*"network prune"*|*"builder prune"*|*"image prune -a"*|*"image prune --all"*) bad "a prune that may reach other people's objects: $line";; esac
done < <(echo "$files" | xargs grep -nE 'docker[[:space:]]+([a-z]+[[:space:]]+)?prune' 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#')

echo "$files" | xargs grep -nE '\$\((docker|sudo docker) (ps|container ls)[^)]*-q|docker (stop|kill|rm|restart) \$\(|docker rm -f \$\(|systemctl (restart|stop) docker|service docker (restart|stop)' 2>/dev/null \
  | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' | while IFS= read -r line; do bad "touches every container or the Docker daemon: $line"; done
# (the loop above runs in a subshell, so count again without it)
if echo "$files" | xargs grep -nE '\$\((docker|sudo docker) (ps|container ls)[^)]*-q|docker (stop|kill|rm|restart) \$\(|docker rm -f \$\(|systemctl (restart|stop) docker|service docker (restart|stop)' 2>/dev/null | grep -vqE '^[^:]+:[0-9]+:[[:space:]]*#'; then fail=1; fi

for f in docker-compose.yml docker-compose.prod.yml; do
  grep -qE '^name: beginso-api(-dev)?$' "$f" || bad "$f must fix the project name: name: beginso-api (or beginso-api-dev)"
  # every ports entry must start with 127.0.0.1:
  if grep -nE '^[[:space:]]+-[[:space:]]*"?[0-9$]' "$f" | grep -E 'ports|:[0-9]+"?$' | grep -vE '127\.0\.0\.1:' | grep -E '"[^"]*:[0-9]+"' >/dev/null; then
    bad "$f publishes a port that is not bound to 127.0.0.1"
  fi
done

[ "$fail" -eq 0 ] && echo "docker hygiene: ok (no unfiltered prune, no touching other containers, fixed project names, loopback ports)"
exit "$fail"
