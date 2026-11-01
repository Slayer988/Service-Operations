#!/usr/bin/env bash
# Service Operations (Ops) installer for Oracle Linux 9 (native install: no containers).
# Installs: Node.js LTS, PostgreSQL 15, Nginx, systemd services (web + worker), firewalld rules, backups, health checks.
# Safe to run again: it upgrades the code and keeps your settings and database.
set -euo pipefail

usage() {
cat <<USAGE
Usage: sudo ./install.sh --domain services.example.com [options]

Required
  --domain NAME           Host name users will open, for example services.labs.local

Optional
  --no-tls                Serve plain HTTP (testing only)
  --cert FILE --key FILE  Use your own certificate. Without them a self-signed certificate is created.
  --admin-email EMAIL     Create the first platform administrator (password printed once)
  --admin-name "Name"     Display name for that administrator
  --timezone ZONE         Default Africa/Nairobi
  --demo                  Load demo customers and users so you can try every screen
  --skip-tests            Do not run the integration tests before starting
  --offline-bundle FILE   node_modules.tar.gz built with scripts/make-offline-bundle.sh (no internet needed)
USAGE
}

DOMAIN=""; TLS=1; CERT_IN=""; KEY_IN=""; ADMIN_EMAIL=""; ADMIN_NAME=""; TZONE="Africa/Nairobi"; DEMO=0; RUN_TESTS=1; BUNDLE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2;;
    --no-tls) TLS=0; shift;;
    --cert) CERT_IN="${2:-}"; shift 2;;
    --key) KEY_IN="${2:-}"; shift 2;;
    --admin-email) ADMIN_EMAIL="${2:-}"; shift 2;;
    --admin-name) ADMIN_NAME="${2:-}"; shift 2;;
    --timezone) TZONE="${2:-}"; shift 2;;
    --demo) DEMO=1; shift;;
    --skip-tests) RUN_TESTS=0; shift;;
    --offline-bundle) BUNDLE="${2:-}"; shift 2;;
    -h|--help) usage; exit 0;;
    *) echo "Unknown option: $1" >&2; usage; exit 1;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "Run as root (use sudo)."
[ -n "$DOMAIN" ] || { usage; die "--domain is required."; }
DOMAIN="$(echo "$DOMAIN" | tr 'A-Z' 'a-z')"
echo "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' || die "Invalid domain: $DOMAIN"
if [ -n "$CERT_IN$KEY_IN" ]; then [ -r "$CERT_IN" ] && [ -r "$KEY_IN" ] || die "--cert and --key must both be readable files."; fi
if [ -n "$ADMIN_EMAIL" ]; then echo "$ADMIN_EMAIL" | grep -Eq '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' || die "Invalid --admin-email"; fi
[ -z "$BUNDLE" ] || [ -r "$BUNDLE" ] || die "Cannot read $BUNDLE"

HERE="$(cd "$(dirname "$0")" && pwd)"
# Work from a directory every service account can enter (otherwise runuser prints "could not change directory" when started from /root).
[ -z "$CERT_IN" ] || CERT_IN="$(readlink -f "$CERT_IN")"; [ -z "$KEY_IN" ] || KEY_IN="$(readlink -f "$KEY_IN")"; [ -z "$BUNDLE" ] || BUNDLE="$(readlink -f "$BUNDLE")"
cd /
[ -f "$HERE/src/server.js" ] || die "Run this script from the unpacked itsm folder (src/server.js not found)."
[ -z "$BUNDLE" ] && [ -f "$HERE/node_modules.tar.gz" ] && BUNDLE="$HERE/node_modules.tar.gz"

. /etc/os-release
[ "${ID:-}" = "ol" ] || echo "WARNING: this is '${ID:-unknown}', not Oracle Linux. Continuing, but it is untested."
case "${VERSION_ID%%.*}" in 9) ;; *) echo "WARNING: written for Oracle Linux 9 (found ${VERSION_ID:-unknown}).";; esac

APP_USER=itsm
APP_DIR=/opt/itsm
CONF_DIR=/etc/itsm
ENV_FILE=$CONF_DIR/itsm.env
DATA_DIR=/var/lib/itsm
PKI_DIR=/etc/pki/itsm
PUBLIC_DIR=$APP_DIR/app/src/public

# ---------------------------------------------------------------- guard: existing PostgreSQL of another version
say "Checking for an existing PostgreSQL database"
if [ -f /var/lib/pgsql/data/PG_VERSION ]; then
  OLDV="$(cat /var/lib/pgsql/data/PG_VERSION)"
  if [ "$OLDV" != "15" ]; then
    die "An existing PostgreSQL $OLDV database was found in /var/lib/pgsql/data. This installer needs PostgreSQL 15 and will not touch your data. Upgrade it first (dnf install postgresql-upgrade; postgresql-setup --upgrade) or move it aside if disposable (mv /var/lib/pgsql/data /var/lib/pgsql/data.old), then re-run."
  fi
fi
if [ -f /etc/nginx/conf.d/itsm.conf ] || ! grep -rqs "server_name[[:space:]]\+$DOMAIN" /etc/nginx/conf.d/ 2>/dev/null; then :; else
  die "Another Nginx site already uses server_name $DOMAIN (see /etc/nginx/conf.d/). Use a different --domain or remove that site first."
fi

# ---------------------------------------------------------------- packages
say "Installing operating-system packages"
dnf -y install nginx rsync openssl curl policycoreutils-python-utils firewalld >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  dnf -y module reset nodejs >/dev/null 2>&1 || true
  dnf -y module enable nodejs:22 >/dev/null 2>&1 || dnf -y module enable nodejs:20 >/dev/null 2>&1 || die "No Node.js 20+ module is available in your dnf repositories."
  dnf -y install nodejs npm >/dev/null
fi
command -v npm >/dev/null || dnf -y install npm >/dev/null
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || die "Node.js 20 or newer is required (found $(node -v))."
dnf -y module reset postgresql >/dev/null 2>&1 || true
dnf -y module enable postgresql:15 >/dev/null 2>&1 || die "Could not enable the PostgreSQL 15 module. Check your dnf repositories."
dnf -y install postgresql-server >/dev/null
echo "Node $(node -v), PostgreSQL $(rpm -q --qf '%{VERSION}' postgresql-server), Nginx $(rpm -q --qf '%{VERSION}' nginx)"

# ---------------------------------------------------------------- PostgreSQL
say "Setting up PostgreSQL"
[ -f /var/lib/pgsql/data/PG_VERSION ] || postgresql-setup --initdb
systemctl enable --now postgresql
for i in $(seq 1 30); do runuser -u postgres -- psql -tAc 'select 1' >/dev/null 2>&1 && break; sleep 1; done
runuser -u postgres -- psql -tAc 'select 1' >/dev/null 2>&1 || die "PostgreSQL did not start. Run: journalctl -u postgresql"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /sbin/nologin "$APP_USER"
# The database role has the same name as the system user: unix socket + peer authentication, so there is no database password.
runuser -u postgres -- psql -tAc "select 1 from pg_roles where rolname='$APP_USER'" | grep -q 1 || runuser -u postgres -- psql -c "create role $APP_USER login" >/dev/null
runuser -u postgres -- psql -tAc "select 1 from pg_database where datname='itsm'" | grep -q 1 || runuser -u postgres -- createdb -O "$APP_USER" -E UTF8 itsm

# ---------------------------------------------------------------- application code
say "Installing the application into $APP_DIR/app"
mkdir -p "$APP_DIR/app" "$CONF_DIR" "$DATA_DIR/storage" /var/backups/itsm
rsync -a --delete --exclude node_modules --exclude storage --exclude '*.tar.gz' "$HERE/src" "$HERE/migrations" "$HERE/scripts" "$HERE/test" "$HERE/package.json" "$APP_DIR/app/"
chown -R root:root "$APP_DIR"; chmod -R go-w "$APP_DIR"; chmod -R a+rX "$APP_DIR"

if [ -n "$BUNDLE" ]; then
  say "Installing Node packages from the offline bundle"
  rm -rf "$APP_DIR/app/node_modules"; tar xzf "$BUNDLE" -C "$APP_DIR/app"
else
  say "Installing Node packages from the npm registry"
  (cd "$APP_DIR/app" && npm install --omit=dev --no-audit --no-fund) \
    || die "npm could not download packages. On a server without internet, build node_modules.tar.gz with scripts/make-offline-bundle.sh on another machine, copy it next to install.sh and re-run."
fi
chown -R root:root "$APP_DIR/app/node_modules"; chmod -R go-w "$APP_DIR/app/node_modules"
for m in express ejs pg express-session connect-pg-simple multer nodemailer imapflow mailparser; do
  [ -d "$APP_DIR/app/node_modules/$m" ] || die "Node package '$m' is missing. Installation of dependencies did not complete."
done

# ---------------------------------------------------------------- configuration
say "Writing configuration"
if [ ! -f "$ENV_FILE" ]; then
  install -m 640 -o root -g "$APP_USER" "$HERE/deploy/itsm.env.example" "$ENV_FILE"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$(openssl rand -hex 32)|" "$ENV_FILE"
else
  echo "Keeping the existing $ENV_FILE (secret, SMTP and mailbox passwords are not overwritten)."
fi
# Values that contain spaces must be quoted (the file is read by bash and by systemd); repairs files written by an earlier 1.2.0 pre-release.
sed -i -E 's#^(MAIL_FROM|APP_NAME)=([^"].*[ ].*)$#\1="\2"#' "$ENV_FILE"
set_env() { if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi; }
SCHEME=$([ "$TLS" -eq 1 ] && echo https || echo http)
set_env BASE_URL "$SCHEME://$DOMAIN"
set_env APP_TIMEZONE "$TZONE"
set_env PGHOST /var/run/postgresql; set_env PGUSER "$APP_USER"; set_env PGDATABASE itsm
set_env STORAGE_DIR "$DATA_DIR/storage"
chown root:"$APP_USER" "$ENV_FILE"; chmod 640 "$ENV_FILE"
mkdir -p "$DATA_DIR/storage"; chown -R "$APP_USER":"$APP_USER" "$DATA_DIR"; chmod 750 "$DATA_DIR" "$DATA_DIR/storage"

appnode() { # run a node script as the service user with the production environment
  runuser -u "$APP_USER" -- bash -c 'set -a; . '"$ENV_FILE"'; set +a; cd '"$APP_DIR"'/app; exec node "$@"' _ "$@"
}

# ---------------------------------------------------------------- tests, migrations
if [ "$RUN_TESTS" -eq 1 ]; then
  say "Running the tests (a temporary database is created and dropped; your data is not touched)"
  runuser -u postgres -- dropdb --if-exists itsm_test >/dev/null 2>&1 || true
  runuser -u postgres -- createdb -O "$APP_USER" -E UTF8 itsm_test
  if ! runuser -u "$APP_USER" -- bash -c "set -a; . $ENV_FILE; set +a; export PGDATABASE=itsm_test SESSION_SECRET=test-secret-test-secret-test-secret-1234 BASE_URL=http://localhost STORAGE_DIR=/tmp/itsm-test-storage; cd $APP_DIR/app && node --test test/unit/*.test.js test/integration/*.test.js"; then
    runuser -u postgres -- dropdb --if-exists itsm_test >/dev/null 2>&1 || true
    die "Tests failed. Nothing was started. Fix the problem shown above, or re-run with --skip-tests to override."
  fi
  runuser -u postgres -- dropdb --if-exists itsm_test >/dev/null 2>&1 || true
  rm -rf /tmp/itsm-test-storage
fi
say "Creating or updating database tables"
appnode scripts/migrate.js

# ---------------------------------------------------------------- TLS, nginx, SELinux, firewall
if [ "$TLS" -eq 1 ]; then
  mkdir -p "$PKI_DIR"; chmod 755 "$PKI_DIR"
  if [ -n "$CERT_IN" ]; then
    say "Installing your certificate"
    install -m 644 "$CERT_IN" "$PKI_DIR/fullchain.pem"; install -m 640 -o root -g nginx "$KEY_IN" "$PKI_DIR/privkey.pem"
  elif [ ! -f "$PKI_DIR/fullchain.pem" ]; then
    say "Creating a self-signed certificate for $DOMAIN (browsers will warn; replace it with a real one later)"
    openssl req -x509 -newkey rsa:3072 -sha256 -days 825 -nodes -keyout "$PKI_DIR/privkey.pem" -out "$PKI_DIR/fullchain.pem" \
      -subj "/CN=$DOMAIN" -addext "subjectAltName=DNS:$DOMAIN" 2>/dev/null
    chmod 644 "$PKI_DIR/fullchain.pem"; chown root:nginx "$PKI_DIR/privkey.pem"; chmod 640 "$PKI_DIR/privkey.pem"
  fi
fi

say "Configuring Nginx"
install -m 644 "$HERE/deploy/itsm-proxy.inc" /etc/nginx/itsm-proxy.inc
if [ "$TLS" -eq 1 ]; then ON=keep; OFF=drop; else ON=drop; OFF=keep; fi
sed -e "s|@@DOMAIN@@|$DOMAIN|g" -e "s|@@CERT@@|$PKI_DIR/fullchain.pem|g" -e "s|@@KEY@@|$PKI_DIR/privkey.pem|g" "$HERE/deploy/nginx-itsm.conf.template" \
  | awk -v on="$ON" -v off="$OFF" '
      /@@TLS_ON@@/  { if (on  == "drop") next; sub(/@@TLS_ON@@/,  "") }
      /@@TLS_OFF@@/ { if (off == "drop") next; sub(/@@TLS_OFF@@/, "") }
      { print }' > /etc/nginx/conf.d/itsm.conf
chmod 644 /etc/nginx/conf.d/itsm.conf
nginx -t

if command -v getenforce >/dev/null && [ "$(getenforce)" != "Disabled" ]; then
  say "Configuring SELinux (staying in enforcing mode)"
  setsebool -P httpd_can_network_connect 1
  semanage fcontext -a -t httpd_sys_content_t "$PUBLIC_DIR(/.*)?" 2>/dev/null || semanage fcontext -m -t httpd_sys_content_t "$PUBLIC_DIR(/.*)?"
  restorecon -R "$PUBLIC_DIR"
  [ "$TLS" -eq 1 ] && restorecon -R "$PKI_DIR"
fi

if systemctl is-active --quiet firewalld || systemctl enable --now firewalld >/dev/null 2>&1; then
  say "Opening ports 80 and 443"
  firewall-cmd --permanent --add-service=http >/dev/null; firewall-cmd --permanent --add-service=https >/dev/null; firewall-cmd --reload >/dev/null
fi

# ---------------------------------------------------------------- services
say "Installing systemd services, backup and health check"
for u in itsm-web.service itsm-worker.service itsm-backup.service itsm-backup.timer itsm-healthcheck.service itsm-healthcheck.timer; do
  install -m 644 "$HERE/deploy/$u" "/etc/systemd/system/$u"
done
install -m 755 "$HERE/deploy/itsm-backup.sh" /usr/local/sbin/itsm-backup
install -m 755 "$HERE/deploy/itsm-healthcheck.sh" /usr/local/sbin/itsm-healthcheck
chmod 700 /var/backups/itsm
systemctl daemon-reload
systemctl enable itsm-web.service itsm-worker.service nginx.service >/dev/null 2>&1
systemctl enable --now itsm-backup.timer itsm-healthcheck.timer >/dev/null 2>&1
systemctl restart itsm-web.service
systemctl restart itsm-worker.service
systemctl restart nginx.service

say "Waiting for the application"
ok=0
for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/healthz >/dev/null 2>&1 && { ok=1; break; }; sleep 1; done
if [ "$ok" -ne 1 ]; then journalctl -u itsm-web -n 40 --no-pager; die "The web application did not start. See the log above."; fi
sleep 2; systemctl is-active --quiet itsm-worker || { journalctl -u itsm-worker -n 30 --no-pager; die "The worker did not start."; }

# ---------------------------------------------------------------- first administrator / demo data
SUMMARY=""
if [ -n "$ADMIN_EMAIL" ]; then
  OUT="$(appnode scripts/create-admin.js --email "$ADMIN_EMAIL" --name "${ADMIN_NAME:-Administrator}" --role platform_admin)"
  SUMMARY+=$'\n'"$OUT"$'\n'"Sign in at $SCHEME://$DOMAIN/ . Two-step verification is required for this role: you will be asked to set it up at first sign-in."
fi
if [ "$DEMO" -eq 1 ]; then SUMMARY+=$'\n'"$(appnode scripts/seed-demo.js)"; fi

cat <<DONE

Service Operations (Ops) is installed and running at $SCHEME://$DOMAIN/
$SUMMARY

Next steps
  1. DNS: point $DOMAIN at this server's IP address.
  2. If you did not use --admin-email:  sudo runuser -u $APP_USER -- bash -c 'set -a; . $ENV_FILE; set +a; cd $APP_DIR/app; node scripts/create-admin.js --email you@example.com --name "Your Name"'
  3. E-mail: edit $ENV_FILE (SMTP_*, MAILBOX_*_PASSWORD) then: systemctl restart itsm-web itsm-worker
     and configure the two shared mailboxes on the E-mail page.
  4. SLA targets are placeholders: replace them with your contract values on the SLA page.
  5. Logs: journalctl -u itsm-web -f   journalctl -u itsm-worker -f      Backups: /var/backups/itsm (daily)
DONE
