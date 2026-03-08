#!/usr/bin/env bash
# install.sh — registers the Page Archiver native messaging host with Brave on Linux
# Run once after installing the extension:  bash install.sh <extension-id>
#
# Your extension ID is shown on brave://extensions (the long string under the name).

set -euo pipefail

EXTENSION_ID="${1:-}"

if [[ -z "$EXTENSION_ID" ]]; then
  echo ""
  echo "  Usage: bash install.sh <your-extension-id>"
  echo ""
  echo "  Find your extension ID at: brave://extensions"
  echo "  It looks like: abcdefghijklmnopqrstuvwxyzabcdef"
  echo ""
  exit 1
fi

# ── Paths ─────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/page_archiver_host.py"
MANIFEST_NAME="com.page_archiver.host"

# Brave on Linux looks here for NativeMessaging host manifests
NM_DIR="$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts"
mkdir -p "$NM_DIR"

MANIFEST_DEST="$NM_DIR/${MANIFEST_NAME}.json"

# ── Make host script executable ───────────────────────────────────────────────

chmod +x "$HOST_SCRIPT"

# Check python3 is available
if ! command -v python3 &>/dev/null; then
  echo "ERROR: python3 not found. Please install Python 3."
  exit 1
fi

# ── Write the manifest ────────────────────────────────────────────────────────

cat > "$MANIFEST_DEST" <<EOF
{
  "name": "${MANIFEST_NAME}",
  "description": "Page Archiver native host — writes to SQLite",
  "path": "${HOST_SCRIPT}",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://${EXTENSION_ID}/"
  ]
}
EOF

echo ""
echo "✅  Native host installed!"
echo ""
echo "    Manifest : $MANIFEST_DEST"
echo "    Host     : $HOST_SCRIPT"
echo "    Extension: $EXTENSION_ID"
echo "    Database : ~/page-archiver/archive.db  (created on first capture)"
echo ""
echo "  Restart Brave (fully quit and reopen) for the change to take effect."
echo ""
echo "  To query your archive later:"
echo "    sqlite3 ~/page-archiver/archive.db"
echo "    > SELECT url, captured_at, trigger FROM snapshots ORDER BY captured_at DESC LIMIT 20;"
echo ""
