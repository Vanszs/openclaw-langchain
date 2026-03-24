#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
CONFIG_PATH="${OPENCLAW_CONFIG_PATH:-$STATE_DIR/openclaw.json}"
RUN_DIR="${OPENCLAW_RUN_DIR:-$STATE_DIR/run}"
LOG_DIR="${OPENCLAW_LOG_DIR:-$STATE_DIR/logs}"
CHROMA_DB_PATH="${OPENCLAW_CHROMA_DB_PATH:-$STATE_DIR/memory/chromadb}"
START_TIMEOUT_SEC="${OPENCLAW_START_TIMEOUT_SEC:-45}"
DRY_RUN="${OPENCLAW_START_DRY_RUN:-0}"
FORCE_GATEWAY="${OPENCLAW_FORCE_GATEWAY:-0}"

mkdir -p "$RUN_DIR" "$LOG_DIR" "$CHROMA_DB_PATH"

fail() {
  echo "error: $*" >&2
  exit 1
}

log() {
  echo "[openclaw-start] $*"
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '[dry-run] '
    printf '%q ' "$@"
    printf '\n'
    return 0
  fi
  "$@"
}

require_cmd() {
  have_cmd "$1" || fail "missing command: $1"
}

require_cmd node
require_cmd chroma

[[ -f "$CONFIG_PATH" ]] || fail "config not found: $CONFIG_PATH"

OPENCLAW_CMD=()
if [[ -f "$REPO_ROOT/package.json" ]]; then
  OPENCLAW_CMD=(node "$REPO_ROOT/scripts/run-node.mjs")
elif have_cmd openclaw; then
  OPENCLAW_CMD=(openclaw)
else
  fail "could not resolve openclaw command"
fi

read_config_field() {
  local key="$1"
  node - "$CONFIG_PATH" "$key" <<'NODE'
const fs = require("node:fs");
const path = process.argv[2];
const key = process.argv[3];
const cfg = JSON.parse(fs.readFileSync(path, "utf8"));
function get(obj, dotted) {
  return dotted.split(".").reduce((acc, part) => (acc && part in acc ? acc[part] : undefined), obj);
}
const value = get(cfg, key);
if (value === undefined || value === null) {
  process.exit(0);
}
if (typeof value === "object") {
  process.stdout.write(JSON.stringify(value));
} else {
  process.stdout.write(String(value));
}
NODE
}

CHROMA_URL="$(read_config_field 'plugins.entries.memory-langchain.config.chromaUrl')"
GATEWAY_PORT="$(read_config_field 'gateway.port')"
GATEWAY_BIND="$(read_config_field 'gateway.bind')"
GATEWAY_TOKEN="$(read_config_field 'gateway.auth.token')"
WORKSPACE_DIR="$(read_config_field 'agents.defaults.workspace')"

if [[ -z "$CHROMA_URL" && -n "${OPENCLAW_CHROMA_URL:-}" ]]; then
  CHROMA_URL="$OPENCLAW_CHROMA_URL"
fi
[[ -n "$CHROMA_URL" ]] || CHROMA_URL="http://127.0.0.1:8889"
[[ -n "$GATEWAY_PORT" ]] || GATEWAY_PORT="18789"
[[ -n "$GATEWAY_BIND" ]] || GATEWAY_BIND="loopback"

read -r CHROMA_HOST CHROMA_PORT < <(
  node - "$CHROMA_URL" <<'NODE'
const raw = process.argv[2];
const url = new URL(raw);
process.stdout.write(`${url.hostname} ${url.port || (url.protocol === "https:" ? "443" : "80")}\n`);
NODE
)

if [[ "$GATEWAY_BIND" == "loopback" ]]; then
  GATEWAY_HOST="127.0.0.1"
else
  GATEWAY_HOST="127.0.0.1"
fi

is_tcp_open() {
  local host="$1"
  local port="$2"
  python3 - "$host" "$port" <<'PY' >/dev/null 2>&1
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])

families = [socket.AF_INET]
if ":" in host:
    families = [socket.AF_INET6]

for family in families:
    try:
        with socket.socket(family, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            sock.connect((host, port))
        raise SystemExit(0)
    except OSError:
        continue

raise SystemExit(1)
PY
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local timeout="$3"
  local elapsed=0
  while (( elapsed < timeout )); do
    if is_tcp_open "$host" "$port"; then
      return 0
    fi
    sleep 1
    ((elapsed += 1))
  done
  return 1
}

gateway_health() {
  if [[ -z "${GATEWAY_TOKEN:-}" ]]; then
    return 1
  fi
  "${OPENCLAW_CMD[@]}" gateway health \
    --url "ws://${GATEWAY_HOST}:${GATEWAY_PORT}" \
    --token "$GATEWAY_TOKEN" \
    >/dev/null 2>&1
}

CHROMA_LOG="$LOG_DIR/chroma.log"
GATEWAY_LOG="$LOG_DIR/openclaw-gateway.log"
CHROMA_PID_FILE="$RUN_DIR/chroma.pid"
GATEWAY_PID_FILE="$RUN_DIR/openclaw-gateway.pid"

log "config: $CONFIG_PATH"
log "workspace: ${WORKSPACE_DIR:-<unset>}"
log "chroma: ${CHROMA_HOST}:${CHROMA_PORT} -> $CHROMA_DB_PATH"
log "gateway: ${GATEWAY_HOST}:${GATEWAY_PORT} bind=${GATEWAY_BIND}"

if [[ "$DRY_RUN" == "1" ]]; then
  log "dry-run mode"
  run_cmd chroma run --path "$CHROMA_DB_PATH" --host "$CHROMA_HOST" --port "$CHROMA_PORT"
  run_cmd "${OPENCLAW_CMD[@]}" gateway run --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --force
  exit 0
fi

if is_tcp_open "$CHROMA_HOST" "$CHROMA_PORT"; then
  log "chroma already listening on ${CHROMA_HOST}:${CHROMA_PORT}; skipping start"
else
  log "starting chroma"
  nohup chroma run --path "$CHROMA_DB_PATH" --host "$CHROMA_HOST" --port "$CHROMA_PORT" \
    >"$CHROMA_LOG" 2>&1 &
  echo "$!" >"$CHROMA_PID_FILE"
  wait_for_port "$CHROMA_HOST" "$CHROMA_PORT" "$START_TIMEOUT_SEC" || {
    tail -n 50 "$CHROMA_LOG" >&2 || true
    fail "chroma did not start within ${START_TIMEOUT_SEC}s"
  }
fi

if is_tcp_open "$GATEWAY_HOST" "$GATEWAY_PORT"; then
  if gateway_health; then
    log "gateway already healthy on ws://${GATEWAY_HOST}:${GATEWAY_PORT}; skipping start"
  elif [[ "$FORCE_GATEWAY" != "1" ]]; then
    fail "gateway port ${GATEWAY_PORT} already in use and health probe did not pass; set OPENCLAW_FORCE_GATEWAY=1 to force"
  fi
fi

if ! is_tcp_open "$GATEWAY_HOST" "$GATEWAY_PORT" || [[ "$FORCE_GATEWAY" == "1" ]]; then
  log "starting openclaw gateway"
  nohup "${OPENCLAW_CMD[@]}" gateway run --bind "$GATEWAY_BIND" --port "$GATEWAY_PORT" --force \
    >"$GATEWAY_LOG" 2>&1 &
  echo "$!" >"$GATEWAY_PID_FILE"
  if ! wait_for_port "$GATEWAY_HOST" "$GATEWAY_PORT" "$START_TIMEOUT_SEC"; then
    tail -n 80 "$GATEWAY_LOG" >&2 || true
    fail "gateway did not start within ${START_TIMEOUT_SEC}s"
  fi
fi

log "ready"
log "chroma log: $CHROMA_LOG"
log "gateway log: $GATEWAY_LOG"
log "chroma pid file: $CHROMA_PID_FILE"
log "gateway pid file: $GATEWAY_PID_FILE"
