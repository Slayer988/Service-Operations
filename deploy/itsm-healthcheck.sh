#!/usr/bin/env bash
# Writes one line per problem to the system log at "err" level (tag itsm-health) so any log-based
# monitoring tool can alert on it (NFR-011). Silent when everything is fine.
CERT=/etc/pki/itsm/fullchain.pem
problem() { logger -p user.err -t itsm-health "$*"; echo "PROBLEM: $*"; }
advice() { logger -p user.warning -t itsm-health "$*"; echo "ADVICE: $*"; }

curl -fsS -m 5 http://127.0.0.1:3000/healthz >/dev/null 2>&1 || problem "web application does not answer /healthz"
systemctl is-active --quiet itsm-worker || problem "itsm-worker service is not running"
systemctl is-active --quiet postgresql || problem "postgresql service is not running"
systemctl is-active --quiet nginx || problem "nginx service is not running"
for p in /var/lib/itsm /var/lib/pgsql /var/backups/itsm; do
  [ -d "$p" ] || continue
  use=$(df --output=pcent "$p" | tail -1 | tr -dc '0-9')
  [ "${use:-0}" -lt 85 ] || problem "disk holding $p is ${use}% full"
done
if [ -f "$CERT" ]; then
  openssl x509 -checkend $((21*86400)) -noout -in "$CERT" >/dev/null 2>&1 || problem "TLS certificate expires within 21 days"
fi
# backups: the backup script records a marker only when every step (dump, files, configuration, read-back, copy) succeeded
BK=/var/backups/itsm
[ -n "$(find "$BK/.last-ok" -mtime -2 2>/dev/null)" ] || problem "no complete, verified backup in $BK in the last 2 days (see: journalctl -t itsm-backup)"
[ -s /etc/itsm/backup.pass ] || advice "backups are not encrypted and do not include /etc/itsm (SESSION_SECRET): create /etc/itsm/backup.pass, see README \"Backup and restore\""
if grep -qs '^BACKUP_COPY_TO=.\+' /etc/itsm/backup.conf; then
  [ -n "$(find "$BK/.last-copy" -mtime -2 2>/dev/null)" ] || problem "no backup copy reached the off-server location in the last 2 days"
else
  advice "backups only exist on this server: set BACKUP_COPY_TO in /etc/itsm/backup.conf to copy them elsewhere"
fi
[ -n "$(find "$BK/.last-restore-test" -mtime -40 2>/dev/null)" ] || advice "no successful restore test in the last 40 days (run: sudo itsm-restore-test)"
# audit log: the worker checks its tamper-evident chain every day
audit=$(runuser -u postgres -- psql -tAc "select coalesce(value->>'ok', 'true') from settings where key = 'audit_verify'" itsm 2>/dev/null)
[ "${audit:-true}" != "false" ] || problem "the audit log failed its integrity check (see Administration > Audit log)"
state=$(runuser -u postgres -- psql -tAc "select count(*) from mailboxes where enabled and last_status <> 'ok'" itsm 2>/dev/null)
[ "${state:-0}" = "0" ] || problem "$state enabled mailbox(es) report an error (see the E-mail page)"
exit 0
