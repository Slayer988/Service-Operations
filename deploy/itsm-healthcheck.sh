#!/usr/bin/env bash
# Writes one line per problem to the system log at "err" level (tag itsm-health) so any log-based
# monitoring tool can alert on it (NFR-011). Silent when everything is fine.
CERT=/etc/pki/itsm/fullchain.pem
problem() { logger -p user.err -t itsm-health "$*"; echo "PROBLEM: $*"; }

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
last=$(find /var/backups/itsm -name 'itsm-db-*.sql.gz' -mtime -2 2>/dev/null | head -1)
[ -n "$last" ] || problem "no database backup newer than 2 days in /var/backups/itsm"
state=$(runuser -u postgres -- psql -tAc "select count(*) from mailboxes where enabled and last_status <> 'ok'" itsm 2>/dev/null)
[ "${state:-0}" = "0" ] || problem "$state enabled mailbox(es) report an error (see the E-mail page)"
exit 0
