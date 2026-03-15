#!/usr/bin/env bash
# Tunnel monitor for TG Canvas
# Checks tunnel health and restarts if needed, updating MINIAPP_URL.
#
# NOTE: This script is designed for QUICK TUNNEL (dev mode) only.
# For named tunnel (production), use systemd services which auto-restart.
#
# Usage:
#   ./scripts/monitor-tunnel.sh           # Single check (for cron)
#   ./scripts/monitor-tunnel.sh --daemon  # Run as daemon (background)
#   ./scripts/monitor-tunnel.sh --status  # Show current status
#
# Recommended: Run via cron every minute
#   * * * * * /path/to/scripts/monitor-tunnel.sh

set -e

TG_CANVAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="/tmp/tg-canvas"
MONITOR_LOG="$LOG_DIR/monitor.log"
PID_FILE="$LOG_DIR/monitor.pid"

mkdir -p "$LOG_DIR"

# ---- Load shared functions ----
source "$TG_CANVAS_DIR/scripts/tunnel-common.sh"

# ---- Load .env ----
if [ -f "$ENV_FILE" ]; then
  set -a
  source "$ENV_FILE"
  set +a
fi

PORT="${PORT:-3721}"
CHECK_INTERVAL=60  # seconds

# ---- Monitor-specific functions ----

monitor_log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$MONITOR_LOG"
}

restart_tunnel() {
  # Don't restart named tunnel - systemd handles that
  if is_named_tunnel; then
    monitor_log "Named tunnel detected - skipping restart (use systemd)"
    return 1
  fi

  monitor_log "Restarting tunnel..."

  # Kill existing tunnel
  local pid=$(get_tunnel_pid)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null || true
    sleep 2
  fi

  # Check cloudflared is available
  if ! command -v cloudflared &>/dev/null; then
    monitor_log "ERROR: cloudflared not found"
    return 1
  fi

  # Clear old log
  : > "$TUNNEL_LOG"

  # Start new tunnel
  nohup cloudflared tunnel --url "http://127.0.0.1:$PORT" > "$TUNNEL_LOG" 2>&1 &

  # Wait for URL (up to 15s)
  local url=""
  for i in {1..15}; do
    sleep 1
    url=$(get_tunnel_url)
    if [ -n "$url" ]; then
      monitor_log "New tunnel URL: $url"
      update_miniapp_url "$url"
      return 0
    fi
  done

  monitor_log "ERROR: Failed to get tunnel URL"
  return 1
}

# ---- Single health check ----

do_check() {
  # Skip monitoring for named tunnel (production mode)
  # Systemd services handle restart and URL is fixed
  if is_named_tunnel; then
    local pid=$(get_tunnel_pid)
    if [ -n "$pid" ]; then
      # Just check process is running, systemd handles the rest
      return 0
    else
      monitor_log "Named tunnel process not running"
      return 1
    fi
  fi

  # Quick tunnel monitoring logic
  local pid=$(get_tunnel_pid)
  local current_url=$(get_tunnel_url)
  local stored_url=$(get_stored_url)

  if [ -z "$pid" ]; then
    monitor_log "Tunnel process not running"
    restart_tunnel || return 1
    return 0
  fi

  local health=$(check_tunnel_health "$current_url")
  if [ "$health" != "healthy" ]; then
    monitor_log "Tunnel unhealthy (URL: $current_url)"
    restart_tunnel || return 1
    return 0
  fi

  if [ "$current_url" != "$stored_url" ]; then
    monitor_log "URL mismatch - updating stored URL"
    update_miniapp_url "$current_url"
  fi

  return 0
}

# ---- Status display ----

show_status() {
  local pid=$(get_tunnel_pid)
  local current_url=$(get_tunnel_url)
  local stored_url=$(get_stored_url)
  local tunnel_type="quick tunnel"

  if is_named_tunnel; then
    tunnel_type="named tunnel"
    current_url="${stored_url:-<configured in Cloudflare>}"
  fi

  local health=$(check_tunnel_health "$current_url")

  echo "=== TG Canvas Tunnel Status ==="
  echo "Type:       $tunnel_type"
  echo "Process:    $([ -n "$pid" ] && echo "running (pid $pid)" || echo "NOT RUNNING")"
  echo "Current URL: ${current_url:-<none>}"
  echo "Stored URL:  ${stored_url:-<none>}"
  echo "Health:      $health"
  echo "Log:         $TUNNEL_LOG"
}

# ---- Daemon mode ----

run_daemon() {
  # Warn if named tunnel - no need for daemon
  if is_named_tunnel; then
    echo "WARNING: Named tunnel detected - daemon not needed (systemd handles restart)"
    echo "Use systemd services for production: systemctl status cloudflared-canvas@<instance>"
    exit 0
  fi

  echo $$ > "$PID_FILE"
  monitor_log "Monitor daemon started (pid $$)"

  trap 'monitor_log "Monitor daemon stopped"; rm -f "$PID_FILE"; exit 0' SIGTERM SIGINT

  while true; do
    do_check || true  # Don't exit on failure in daemon mode
    sleep $CHECK_INTERVAL
  done
}

stop_daemon() {
  if [ -f "$PID_FILE" ]; then
    local pid=$(cat "$PID_FILE")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null
      monitor_log "Monitor daemon stopped (pid $pid)"
    else
      monitor_log "Monitor daemon not running (stale PID file)"
    fi
    rm -f "$PID_FILE"
  else
    echo "No monitor daemon running"
  fi
}

# ---- Main ----

case "${1:-}" in
  --daemon)
    run_daemon
    ;;
  --status)
    show_status
    ;;
  --stop)
    stop_daemon
    ;;
  *)
    do_check
    ;;
esac
