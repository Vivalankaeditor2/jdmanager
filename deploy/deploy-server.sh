#!/bin/bash
# Server-side deploy for JD Manager. Run as root on the target host.
#
# Inputs (env):
#   APP_DIR   install directory        (default /srv/jd-manager)
#   APP_PORT  local port the app binds (default 3099)
#   APP_NAME  pm2 process name         (default jd-manager)
#   TARBALL   path to the release tar  (default /tmp/jd-manager.tar.gz)
#
# Behaviour: back up the current release, extract the new one over it
# (preserving data/ runtime state), restart under pm2, health-check, and
# roll back automatically if the health check fails.
set -uo pipefail

: "${APP_DIR:=/srv/jd-manager}"
: "${APP_PORT:=3099}"
: "${APP_NAME:=jd-manager}"
: "${TARBALL:=/tmp/jd-manager.tar.gz}"

if [ ! -f "$TARBALL" ]; then
  echo "ERROR: tarball not found: $TARBALL"
  exit 2
fi

BACKUP="${APP_DIR}.bak-$(date +%Y%m%d%H%M%S)"

echo "== backup current release =="
if [ -d "$APP_DIR" ]; then
  cp -a "$APP_DIR" "$BACKUP"
  echo "backed up -> $BACKUP"
else
  echo "no existing release at $APP_DIR (fresh install)"
fi

rollback() {
  echo "!! rolling back to $BACKUP"
  rm -rf "$APP_DIR"
  mv "$BACKUP" "$APP_DIR"
  PORT="$APP_PORT" HOST=127.0.0.1 pm2 restart "$APP_NAME" --update-env >/dev/null 2>&1 || true
  pm2 save >/dev/null 2>&1 || true
}

echo "== extract new release =="
mkdir -p "$APP_DIR"
tar -xzf "$TARBALL" -C "$APP_DIR" || { rollback; exit 1; }
mkdir -p "$APP_DIR/data"

start_or_restart() {
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    PORT="$APP_PORT" HOST=127.0.0.1 pm2 restart "$APP_NAME" --update-env
  else
    PORT="$APP_PORT" HOST=127.0.0.1 pm2 start "$APP_DIR/server.js" --name "$APP_NAME" --update-env
  fi
  pm2 save
}

echo "== (re)start under pm2 =="
start_or_restart

echo "== health check =="
code=000
for _ in 1 2 3 4 5; do
  sleep 1
  code=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${APP_PORT}/" || echo 000)
  echo "  attempt: http_code=$code"
  [ "$code" = "200" ] && break
done

if [ "$code" != "200" ]; then
  echo "HEALTH CHECK FAILED (http_code=$code)"
  [ -d "$BACKUP" ] && rollback
  exit 1
fi

api=$(curl -s "http://127.0.0.1:${APP_PORT}/api/jds" | head -c 120)
echo "  /api/jds -> ${api}"

echo "== prune old backups (keep 3) =="
ls -1dt "${APP_DIR}".bak-* 2>/dev/null | tail -n +4 | xargs -r rm -rf

echo "DEPLOY OK on port ${APP_PORT}"
