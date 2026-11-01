#!/usr/bin/env bash
# Daily backup: PostgreSQL dump + uploaded files + original e-mails. Keeps KEEP_DAYS days (NFR-005).
# Restore steps: see README.md ("Backup and restore").
set -euo pipefail
DEST=/var/backups/itsm
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$DEST"
runuser -u postgres -- pg_dump --no-owner itsm | gzip > "$DEST/itsm-db-$STAMP.sql.gz.part"
mv "$DEST/itsm-db-$STAMP.sql.gz.part" "$DEST/itsm-db-$STAMP.sql.gz"
tar -C /var/lib/itsm -czf "$DEST/itsm-files-$STAMP.tar.gz.part" storage
mv "$DEST/itsm-files-$STAMP.tar.gz.part" "$DEST/itsm-files-$STAMP.tar.gz"
find "$DEST" -name 'itsm-*' -mtime +"$KEEP_DAYS" -delete
logger -t itsm-backup "backup $STAMP written to $DEST"
