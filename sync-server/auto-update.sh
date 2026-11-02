#!/bin/sh
# Brings this server up to date with main once CI has passed. Cron runs it every five minutes; see README.md.
# Only the app code updates itself. Dockerfile and docker-compose.yml decide what the container may touch on this
# machine, and this script decides what runs at all, so changes to those three stay a deliberate step by hand.
set -eu

REPO=fouadboudouhi/volumora
FILES="server.js admin.js package.json"
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:8787/}
HEALTH_TRIES=${HEALTH_TRIES:-10}
HEALTH_WAIT=${HEALTH_WAIT:-3}
DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$DIR"

log() { echo "$(date '+%F %T') $*"; }

# Any answer counts, also a 401: the server only has to be up. A 5xx or no connection does not count.
healthy() {
  code=$(curl -s -o /dev/null -m 5 -w '%{http_code}' "$HEALTH_URL" || true)
  [ "$code" != 000 ] && [ "${code#5}" = "$code" ]
}

# It has to answer and still be there a moment later, or a server that crashes after starting would pass.
comes_up() {
  tries=0
  while [ "$tries" -lt "$HEALTH_TRIES" ]; do
    tries=$((tries + 1))
    sleep "$HEALTH_WAIT"
    if healthy; then
      sleep "$HEALTH_WAIT"
      healthy && return 0
    fi
  done
  return 1
}

# No network is no news: the next run tries again.
sha=$(git ls-remote "https://github.com/$REPO" refs/heads/main 2>/dev/null | cut -f1) || exit 0
[ -n "$sha" ] || exit 0
[ "$sha" = "$(cat .auto-update-sha 2>/dev/null || true)" ] && exit 0

new=$(mktemp -d)
trap 'rm -rf "$new"' EXIT
for file in $FILES; do
  curl -fsS -m 30 -o "$new/$file" "https://raw.githubusercontent.com/$REPO/$sha/sync-server/$file" 2>/dev/null || exit 0
done

changed=
for file in $FILES; do
  cmp -s "$new/$file" "$file" || changed=1
done
if [ -z "$changed" ]; then
  echo "$sha" >.auto-update-sha
  exit 0
fi

# CI may still be running or may have failed. Without a green result this commit is looked at again next time.
checks=$(curl -fsS -m 30 "https://api.github.com/repos/$REPO/commits/$sha/check-runs?check_name=test&filter=latest" 2>/dev/null) || exit 0
echo "$checks" | grep -q '"conclusion": *"success"' || exit 0

# From here on this commit gets exactly one try, so a broken version cannot restart the server every five minutes.
echo "$sha" >.auto-update-sha
log "updating to $sha"
rm -rf previous
mkdir previous
(umask 077 && tar -czf previous/data.tar.gz data)
for file in $FILES; do
  cp "$file" previous/
done
for file in $FILES; do
  cp "$new/$file" "$file"
done

if docker compose up -d --build >/dev/null 2>&1 && comes_up; then
  log "running $sha"
  exit 0
fi

log "$sha did not come up, going back"
for file in $FILES; do
  cp "previous/$file" "$file"
done
docker compose up -d --build >/dev/null 2>&1 || true
if comes_up; then
  log "back on the previous version"
else
  log "the previous version does not come up either"
fi
exit 1
