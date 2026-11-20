#!/usr/bin/env bash
# Run on a machine WITH internet access (Node 20+ installed) to build node_modules.tar.gz for a server without
# internet. All dependencies are pure JavaScript, so the bundle works on any CPU type.
#   ./scripts/make-offline-bundle.sh   ->  creates ./node_modules.tar.gz  (copy it next to install.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf node_modules
npm install --omit=dev --no-audit --no-fund
tar czf node_modules.tar.gz node_modules
echo "Created node_modules.tar.gz ($(du -h node_modules.tar.gz | cut -f1))"
