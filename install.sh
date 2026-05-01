#!/usr/bin/env bash
# hookbus-publisher-openclaw one-shot installer.
# Installs the plugin into the OpenClaw extension directory and writes a
# plugin-local hookbus.env so normal `openclaw` / gateway launches are wired
# to HookBus without relying on shell profile exports.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$HOME/.openclaw/extensions/cre}"
ENV_FILE="$PLUGIN_DIR/hookbus.env"
HOOKBUS_URL="${HOOKBUS_URL:-http://localhost:18800/event}"
HOOKBUS_FAIL_MODE="${HOOKBUS_FAIL_MODE:-closed}"
HOOKBUS_SOURCE="${HOOKBUS_SOURCE:-openclaw}"
OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"

say() { printf "\033[1;32m[openclaw-publisher]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[openclaw-publisher]\033[0m %s\n" "$*"; }
die() { printf "\033[1;31m[openclaw-publisher] error:\033[0m %s\n" "$*" >&2; exit 1; }

[ -f "$SCRIPT_DIR/index.js" ] || die "index.js not found; run from repo root"
[ -f "$SCRIPT_DIR/openclaw.plugin.json" ] || die "openclaw.plugin.json not found; run from repo root"

mkdir -p "$PLUGIN_DIR"
install -Dm644 "$SCRIPT_DIR/index.js" "$PLUGIN_DIR/index.js"
install -Dm644 "$SCRIPT_DIR/openclaw.plugin.json" "$PLUGIN_DIR/openclaw.plugin.json"
[ -f "$SCRIPT_DIR/package.json" ] && install -Dm644 "$SCRIPT_DIR/package.json" "$PLUGIN_DIR/package.json"
say "installed plugin to $PLUGIN_DIR"

TMP_ENV="$(mktemp "$PLUGIN_DIR/.hookbus.env.XXXXXX")"
trap 'rm -f "$TMP_ENV"' EXIT
chmod 600 "$TMP_ENV"
{
  echo "# hookbus-publisher-openclaw config. Mode 600. Read by the plugin at startup."
  echo "HOOKBUS_URL=$HOOKBUS_URL"
  echo "HOOKBUS_SOURCE=$HOOKBUS_SOURCE"
  echo "HOOKBUS_FAIL_MODE=$HOOKBUS_FAIL_MODE"
  if [ -n "${HOOKBUS_TOKEN:-}" ]; then
    echo "HOOKBUS_TOKEN=$HOOKBUS_TOKEN"
  fi
} > "$TMP_ENV"
mv "$TMP_ENV" "$ENV_FILE"
trap - EXIT
chmod 600 "$ENV_FILE"
say "wrote config to $ENV_FILE"

if [ -z "${HOOKBUS_TOKEN:-}" ]; then
  warn "HOOKBUS_TOKEN not set. Authenticated buses will reject events until hookbus.env contains it."
  warn "Fetch with: docker exec hookbus cat /root/.hookbus/.token"
fi

if command -v systemctl >/dev/null 2>&1; then
  UNIT_DIR="$HOME/.config/systemd/user/openclaw-gateway.service.d"
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT_DIR/hookbus.conf" <<DROPIN
[Service]
Environment="HOOKBUS_URL=$HOOKBUS_URL"
Environment="HOOKBUS_SOURCE=$HOOKBUS_SOURCE"
Environment="HOOKBUS_FAIL_MODE=$HOOKBUS_FAIL_MODE"
Environment="HOOKBUS_TOKEN=${HOOKBUS_TOKEN:-}"
DROPIN
  chmod 600 "$UNIT_DIR/hookbus.conf"
  systemctl --user daemon-reload >/dev/null 2>&1 || true
  if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
    "$OPENCLAW_BIN" config set plugins.allow '["cre"]' >/dev/null 2>&1 || \
      warn "could not pin plugins.allow via openclaw config; set plugins.allow=[\"cre\"] manually"
    "$OPENCLAW_BIN" config set plugins.installs.cre.source path >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" config set plugins.installs.cre.sourcePath "$PLUGIN_DIR" >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" config set plugins.installs.cre.installPath "$PLUGIN_DIR" >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" config set plugins.installs.cre.version "$(node -e "console.log(require('$PLUGIN_DIR/package.json').version)" 2>/dev/null || echo unknown)" >/dev/null 2>&1 || true
    "$OPENCLAW_BIN" config set gateway.mode local >/dev/null 2>&1 || \
      warn "could not set gateway.mode=local; run: openclaw config set gateway.mode local"
    "$OPENCLAW_BIN" config set gateway.bind loopback >/dev/null 2>&1 || true
  else
    warn "openclaw command not found; plugin installed but OpenClaw config was not updated."
  fi

  if command -v "$OPENCLAW_BIN" >/dev/null 2>&1; then
    "$OPENCLAW_BIN" gateway install >/dev/null 2>&1 || warn "could not install openclaw-gateway service"
    "$OPENCLAW_BIN" gateway start >/dev/null 2>&1 || warn "could not start openclaw-gateway service"
  fi

  if systemctl --user is-active --quiet openclaw-gateway 2>/dev/null; then
    systemctl --user restart openclaw-gateway || warn "could not restart openclaw-gateway; restart OpenClaw manually"
    say "restarted openclaw-gateway"
  else
    warn "openclaw-gateway not active; run: openclaw gateway install && openclaw gateway start"
  fi
fi

cat <<SUMMARY

Done. Normal OpenClaw launches should load HookBus through:
  $PLUGIN_DIR

Verify:
  openclaw plugins list | grep cre
  openclaw gateway status
  openclaw capability model run --prompt "Reply with: PONG"

Then open HookBus and check for source=$HOOKBUS_SOURCE.
SUMMARY
