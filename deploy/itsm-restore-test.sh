#!/usr/bin/env bash
# Proves that the newest backup can really be restored: loads the database dump into a throw-away database, checks that the
# data and the audit chain are intact, reads the files archive and the configuration bundle, then removes the throw-away database.
# Nothing on the live system is touched. Run monthly by itsm-restore-test.timer; run it by hand any time.
set -euo pipefail
DEST="${ITSM_BACKUP_DIR:-/var/backups/itsm}"            # (the ITSM_* variables only exist so the script can be tried out on a test machine)
PASS_FILE="${ITSM_CONF_DIR:-/etc/itsm}/backup.pass"
CONF_NAME="$(basename "${ITSM_CONF_DIR:-/etc/itsm}")"
TESTDB=itsm_restore_test
fail() { logger -p user.err -t itsm-restore-test "FAILED: $*"; echo "restore test FAILED: $*" >&2; exit 1; }
decrypt() { openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass "file:$PASS_FILE"; }
back() { case "$1" in *.enc) decrypt < "$1" ;; *) cat "$1" ;; esac; }
newest() { ls -1t "$DEST"/$1 2>/dev/null | head -1 || true; }

DB="$(newest 'itsm-db-*.sql.gz*')"; FILES="$(newest 'itsm-files-*.tar.gz*')"; CFG="$(newest 'itsm-config-*.tar.gz.enc')"
[ -n "$DB" ] || fail "there is no database backup in $DEST"
[ -n "$FILES" ] || fail "there is no files backup in $DEST"
case "$DB$FILES$CFG" in *.enc*) [ -s "$PASS_FILE" ] || fail "the backups are encrypted but $PASS_FILE is missing";; esac

ERR="$(mktemp)"
cleanup() { rm -f "$ERR"; runuser -u postgres -- dropdb --if-exists "$TESTDB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup
runuser -u postgres -- createdb "$TESTDB" || fail "could not create the test database"
back "$DB" | gunzip | runuser -u postgres -- psql -q -v ON_ERROR_STOP=1 -d "$TESTDB" > /dev/null 2>"$ERR" || fail "the database dump did not load: $(head -c 300 "$ERR")"

q() { runuser -u postgres -- psql -tA -d "$TESTDB" -c "$1"; }
users="$(q 'select count(*) from users' 2>/dev/null)" || fail "the restored database has no users table"
tickets="$(q 'select count(*) from tickets' 2>/dev/null)" || fail "the restored database has no tickets table"
migs="$(q 'select count(*) from schema_migrations' 2>/dev/null)" || fail "the restored database has no migration record"
[ "${users:-0}" -ge 1 ] || fail "the restored database has no users"
[ "${migs:-0}" -ge 1 ] || fail "the restored database has no migration record"
chain="$(q "select case when to_regproc('audit_verify') is null then 'n/a' else coalesce(audit_verify()::text, 'ok') end" 2>/dev/null)" || fail "the audit chain could not be checked"
[ "$chain" = "-1" ] && fail "the newest entries of the audit log are missing from the restored database"
[ "$chain" = "ok" ] || [ "$chain" = "n/a" ] || fail "the restored audit log does not match its chain (first mismatch at entry $chain)"

back "$FILES" | tar -tzf - > /dev/null || fail "the files archive cannot be read"
if [ -n "$CFG" ]; then back "$CFG" | tar -tzf - | grep -q "$CONF_NAME/itsm.env" || fail "the configuration bundle does not contain itsm.env"; fi

touch "$DEST/.last-restore-test"
logger -t itsm-restore-test "restore test passed: $users users, $tickets tickets, audit chain $chain, files and configuration readable (database $(basename "$DB"))"
echo "restore test passed: $users users, $tickets tickets, audit chain $chain"
