#!/usr/bin/env bash
# Shared functions for TG Canvas tunnel management
# Source this file: source scripts/tunnel-common.sh

TG_CANVAS_DIR="${TG_CANVAS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
ENV_FILE="$TG_CANVAS_DIR/.env"
LOG_DIR="${LOG_DIR:-/tmp/tg-canvas}"
TUNNEL_LOG="$LOG_DIR/tunnel.log"

# Ensure LOG_DIR exists
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

# Check if using named tunnel (production) or quick tunnel (dev)
# Named tunnel: CLOUDFLARED_TUNNEL env var is set
# Quick tunnel: uses --url flag with random URL
is_named_tunnel() {
  # Check environment variable
  if [ -n "${CLOUDFLARED_TUNNEL:-}" ]; then
    return 0
  fi
  # Check if process is running with "tunnel run" (named tunnel)
  if pgrep -f "cloudflared tunnel run" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

# Get quick tunnel URL from log (only works for quick tunnel)
get_tunnel_url() {
  # Use grep -E for better compatibility (works on macOS/BSD)
  grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" 2>/dev/null | tail -1
}

# Get cloudflared process ID
# For quick tunnel: matches --url with port
# For named tunnel: matches "tunnel run"
get_tunnel_pid() {
  if is_named_tunnel; then
    pgrep -f "cloudflared tunnel run" 2>/dev/null || echo ""
  else
    local port="${PORT:-3721}"
    pgrep -f "cloudflared tunnel.*--url.*$port" 2>/dev/null || echo ""
  fi
}

get_stored_url() {
  grep '^MINIAPP_URL=' "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 || echo ""
}

update_miniapp_url() {
  local url="$1"
  if [ -z "$url" ]; then return 1; fi

  # Skip update for named tunnel (URL is fixed in Cloudflare dashboard)
  if is_named_tunnel; then
    log "Skipping URL update for named tunnel"
    return 0
  fi

  if [ -f "$ENV_FILE" ]; then
    if grep -q '^MINIAPP_URL=' "$ENV_FILE"; then
      sed -i "s|^MINIAPP_URL=.*|MINIAPP_URL=$url|" "$ENV_FILE"
    else
      echo "MINIAPP_URL=$url" >> "$ENV_FILE"
    fi
    log "Updated MINIAPP_URL to: $url"
    sync_telegram_menu
  fi
}

sync_telegram_menu() {
  if [ -f "$TG_CANVAS_DIR/scripts/setup-bot.js" ]; then
    log "Syncing Telegram menu button..."
    cd "$TG_CANVAS_DIR"
    local output exit_code
    # Use 'if' to prevent set -e from causing premature exit
    if output=$(node scripts/setup-bot.js 2>&1); then
      exit_code=0
    else
      exit_code=$?
    fi

    # Print output line by line
    while IFS= read -r line; do
      log "  $line"
    done <<< "$output"

    if [ $exit_code -eq 0 ]; then
      log "Telegram menu button synced"
    else
      log "WARNING: Failed to sync Telegram menu button (exit code: $exit_code)"
    fi
  fi
}

# Health check - works for both tunnel types
check_tunnel_health() {
  local url="$1"

  # For named tunnel, use stored URL
  if is_named_tunnel && [ -z "$url" ]; then
    url=$(get_stored_url)
  fi

  if [ -z "$url" ]; then
    echo "no_url"
    return 1
  fi

  local response
  response=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url/health" 2>/dev/null || echo "000")

  if [ "$response" = "200" ]; then
    echo "healthy"
    return 0
  else
    echo "unhealthy"
    return 1
  fi
}
