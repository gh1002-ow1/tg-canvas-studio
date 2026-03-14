#!/usr/bin/env bash
# TG Canvas startup script for Codespaces / local development
# This script manages both the Node server and cloudflared tunnel.
# For production systemd deployments, use the separate service units instead.

set -e

TG_CANVAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$TG_CANVAS_DIR/.env"
LOG_DIR="/tmp/tg-canvas"
SERVER_LOG="$LOG_DIR/server.log"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

mkdir -p "$LOG_DIR"

# ---- Helper functions ----

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

get_tunnel_url() {
  grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1
}

update_miniapp_url() {
  local url="$1"
  if [ -z "$url" ]; then return 1; fi
  
  if [ -f "$ENV_FILE" ]; then
    # Update or append MINIAPP_URL
    if grep -q '^MINIAPP_URL=' "$ENV_FILE"; then
      sed -i "s|^MINIAPP_URL=.*|MINIAPP_URL=$url|" "$ENV_FILE"
    else
      echo "MINIAPP_URL=$url" >> "$ENV_FILE"
    fi
    log "Updated MINIAPP_URL in $ENV_FILE"
  fi
}

# ---- Start Node server ----

start_server() {
  if pgrep -f "node server.js" >/dev/null 2>&1; then
    log "Node server already running"
    return 0
  fi

  if [ ! -f "$ENV_FILE" ]; then
    log "ERROR: .env not found at $ENV_FILE"
    return 1
  fi

  cd "$TG_CANVAS_DIR"

  if [ ! -d "node_modules" ]; then
    log "Installing dependencies..."
    npm install --silent
  fi

  log "Starting Node server..."
  # Source env and start server
  set -a
  source "$ENV_FILE"
  set +a
  
  nohup node server.js > "$SERVER_LOG" 2>&1 &
  
  sleep 2
  
  if pgrep -f "node server.js" >/dev/null 2>&1; then
    log "Node server started on port ${PORT:-3721}"
    return 0
  else
    log "ERROR: Failed to start Node server. Check $SERVER_LOG"
    return 1
  fi
}

# ---- Start Cloudflare tunnel ----

start_tunnel() {
  local port="${PORT:-3721}"
  
  if pgrep -f "cloudflared tunnel.*$port" >/dev/null 2>&1; then
    log "Cloudflared tunnel already running"
    return 0
  fi
  
  if ! command -v cloudflared &>/dev/null; then
    log "WARNING: cloudflared not found, skipping tunnel"
    return 0
  fi
  
  log "Starting Cloudflare tunnel..."
  nohup cloudflared tunnel --url "http://127.0.0.1:$port" > "$TUNNEL_LOG" 2>&1 &
  
  # Wait for tunnel URL to appear (up to 15s)
  local url=""
  for i in {1..15}; do
    sleep 1
    url=$(get_tunnel_url)
    if [ -n "$url" ]; then
      log "Tunnel URL: $url"
      update_miniapp_url "$url"
      return 0
    fi
  done
  
  log "WARNING: Tunnel started but URL not detected yet. Check $TUNNEL_LOG"
  return 0
}

# ---- Main ----

main() {
  log "Starting TG Canvas for development..."
  
  start_server || exit 1
  start_tunnel
  
  log "TG Canvas is running."
  log "  - Server log: $SERVER_LOG"
  log "  - Tunnel log: $TUNNEL_LOG"
  
  if [ -f "$TUNNEL_LOG" ]; then
    local url=$(get_tunnel_url)
    if [ -n "$url" ]; then
      log "  - MiniApp URL: $url"
    fi
  fi
}

main "$@"
