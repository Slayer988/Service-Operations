#!/usr/bin/env bash
# Daily backup of everything needed to rebuild the system: the PostgreSQL database, the uploaded files and original e-mails, and the
# configuration in /etc/itsm (which holds SESSION_SECRET: without it the passwords stored in the database cannot be read again).
#
#  * Every file is checked after it is written. If any step fails the run stops with an error, the health check reports it, and the
#    "last good backup" marker is not updated.
#  * With a passphrase file (/etc/itsm/backup.pass, created by the installer) every file is encrypted with AES-256. The configuration
#    bundle is ONLY ever written encrypted. Keep the passphrase in your password vault: without it the backups cannot be opened.
#  * With BACKUP_COPY_TO set in /etc/itsm/backup.conf, a copy is also sent off this server (rsync over ssh to "user@host:/path",
#    or a plain folder such as a mounted network share).
# Restore steps and settings: README.md ("Backup and restore").
set -euo pipefail

# (the ITSM_* variables only exist so the script can be tried out on a test machine; a normal install never sets them)
DEST="${ITSM_BACKUP_DIR:-/var/backups/itsm}"
CONF_DIR="${ITSM_CONF_DIR:-/etc/itsm}"
DATA_DIR="${ITSM_DATA_DIR:-/var/lib/itsm}"
DBNAME="${ITSM_DB:-itsm}"
CONF_FILE="$CONF_DIR/backup.conf"
PASS_FILE="$CONF_DIR/backup.pass"
KEEP_DAYS=14
BACKUP_COPY_TO=""
# shellcheck disable=SC1090
[ -f "$CONF_FILE" ] && . "$CONF_FILE"

STAMP="$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$DEST"
trap 'rm -f "$DEST"/*.part' EXIT          # a half-written file is never left behind
fail() { logger -p user.err -t itsm-backup "FAILED: $*"; echo "backup FAILED: $*" >&2; exit 1; }

ENC=0; SUFFIX=""
if [ -s "$PASS_FILE" ]; then ENC=1; SUFFIX=".enc"; fi
encrypt() { openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass "file:$PASS_FILE"; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE"; }
out() { if [ "$ENC" -eq 1 ]; then encrypt; else cat; fi; }
back() { if [ "$ENC" -eq 1 ]; then decrypt < "$1"; else cat "$1"; fi; }

DB="$DEST/itsm-db-$STAMP.sql.gz$SUFFIX"
FILES="$DEST/itsm-files-$STAMP.tar.gz$SUFFIX"
CFG="$DEST/itsm-config-$STAMP.tar.gz.enc"

# 1. database
runuser -u postgres -- pg_dump --no-owner "$DBNAME" | gzip | out > "$DB.part" || fail "database dump"
back "$DB.part" | gzip -t || fail "the database dump cannot be read back"
mv "$DB.part" "$DB"

# 2. uploaded files and original e-mails
tar -C "$DATA_DIR" -czf - storage | out > "$FILES.part" || fail "files archive"
back "$FILES.part" | tar -tzf - > /dev/null || fail "the files archive cannot be read back"
mv "$FILES.part" "$FILES"

# 3. configuration (secrets): never stored unencrypted
if [ "$ENC" -eq 1 ]; then
  tar -C "$(dirname "$CONF_DIR")" -czf - "$(basename "$CONF_DIR")" | encrypt > "$CFG.part" || fail "configuration archive"
  decrypt < "$CFG.part" | tar -tzf - > /dev/null || fail "the configuration archive cannot be read back"
  mv "$CFG.part" "$CFG"
else
  logger -p user.warning -t itsm-backup "no passphrase file ($PASS_FILE): the configuration (/etc/itsm) is NOT in this backup and the files are not encrypted"
fi

# 4. a checksum list, so a copy can be checked after it travels
( cd "$DEST" && sha256sum "$(basename "$DB")" "$(basename "$FILES")" $( [ -f "$CFG" ] && basename "$CFG" ) > "itsm-sums-$STAMP.txt" )

# 5. an off-server copy
if [ -n "$BACKUP_COPY_TO" ]; then
  if [[ "$BACKUP_COPY_TO" == *:* ]]; then
    rsync -a --partial -e "ssh -o BatchMode=yes -o ConnectTimeout=20" "$DB" "$FILES" "$DEST/itsm-sums-$STAMP.txt" $( [ -f "$CFG" ] && echo "$CFG" ) "$BACKUP_COPY_TO/" || fail "copy to $BACKUP_COPY_TO"
  else
    mkdir -p "$BACKUP_COPY_TO" && cp -a "$DB" "$FILES" "$DEST/itsm-sums-$STAMP.txt" $( [ -f "$CFG" ] && echo "$CFG" ) "$BACKUP_COPY_TO/" || fail "copy to $BACKUP_COPY_TO"
  fi
  touch "$DEST/.last-copy"
fi

# 6. keep KEEP_DAYS days, then record that this run was good (the health check looks at this marker)
find "$DEST" -maxdepth 1 -name 'itsm-*' -mtime +"$KEEP_DAYS" -delete
touch "$DEST/.last-ok"
logger -t itsm-backup "backup $STAMP written to $DEST (encrypted: $ENC${BACKUP_COPY_TO:+, copied to $BACKUP_COPY_TO})"
