#!/usr/bin/env bash
# Waits until a URL answers HTTP 200, for at most N seconds. Exit 0 = healthy, 1 = it never did.
#   scripts/docker-wait.sh http://127.0.0.1:5000/api/health 60
set -u
url="${1:?usage: docker-wait.sh <url> [seconds]}"
seconds="${2:-60}"
end=$((SECONDS + seconds))
while [ "$SECONDS" -lt "$end" ]; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$url" || true)"
  if [ "$code" = "200" ]; then
    echo "healthy: $url answered 200"
    exit 0
  fi
  sleep 2
done
echo "NOT healthy: $url did not answer 200 within ${seconds}s (last status: ${code:-none})" >&2
exit 1
