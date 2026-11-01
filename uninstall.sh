#!/usr/bin/env bash
# Removes the Service Operations (Ops) application. Your database, uploaded files and backups are kept unless you add --purge-data.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 1; }
cd /   # never run from inside /opt/itsm, which is about to be deleted
PURGE=0; [ "${1:-}" = "--purge-data" ] && PURGE=1
systemctl disable --now itsm-web.service itsm-worker.service itsm-backup.timer itsm-healthcheck.timer 2>/dev/null || true
rm -f /etc/systemd/system/itsm-*.service /etc/systemd/system/itsm-*.timer /usr/local/sbin/itsm-backup /usr/local/sbin/itsm-healthcheck \
      /etc/nginx/conf.d/itsm.conf /etc/nginx/itsm-proxy.inc
systemctl daemon-reload
systemctl reload nginx 2>/dev/null || true
rm -rf /opt/itsm
if [ "$PURGE" -eq 1 ]; then
  read -r -p "This DELETES the database, uploaded files, settings and backups. Type DELETE to continue: " a
  [ "$a" = "DELETE" ] || { echo "Cancelled; application removed, data kept."; exit 0; }
  runuser -u postgres -- dropdb --if-exists itsm || true
  runuser -u postgres -- psql -c "drop role if exists itsm" || true
  rm -rf /etc/itsm /var/lib/itsm /var/backups/itsm /etc/pki/itsm
  userdel itsm 2>/dev/null || true
  echo "Everything removed."
else
  echo "Application removed. Kept: database 'itsm', /var/lib/itsm, /etc/itsm, /var/backups/itsm."
fi
