#!/usr/bin/env bash

TG_CANVAS_DIR="$HOME/projects/tg-canvas-studio"
ENV_FILE="$TG_CANVAS_DIR/.env"
LOG_FILE="/tmp/tg-canvas.log"
CLOUDFLARED_LOG="/tmp/cloudflared.log"

# Start TG Canvas server
if pgrep -f "node server.js" >/dev/null 2>&1; then
    echo "TG Canvas already running"
else
    if [ ! -f "$ENV_FILE" ]; then
        echo "TG Canvas .env not found at $ENV_FILE"
        exit 1
    fi

    cd "$TG_CANVAS_DIR"

    if [ ! -d "node_modules" ]; then
        npm install --silent
    fi

    set -a
    source "$ENV_FILE"
    set +a

    nohup node server.js > "$LOG_FILE" 2>&1 &
    sleep 2

    if pgrep -f "node server.js" >/dev/null 2>&1; then
        echo "TG Canvas started on port 3721"
    else
        echo "Failed to start TG Canvas. Check $LOG_FILE"
        exit 1
    fi
fi

# Start Cloudflare Tunnel
if pgrep -f "cloudflared tunnel" >/dev/null 2>&1; then
    echo "Cloudflared already running"
else
    echo "Starting Cloudflare Tunnel..."
    nohup cloudflared tunnel --url http://127.0.0.1:3721 > "$CLOUDFLARED_LOG" 2>&1 &
    sleep 8
    
    TUNNEL_URL=$(grep -oP 'https://[a-z0-9-]+\.trycloudflare\.com' "$CLOUDFLARED_LOG" | head -1)
    if [ -n "$TUNNEL_URL" ]; then
        echo "Cloudflare Tunnel started: $TUNNEL_URL"
        # Update MINIAPP_URL in .env
        if [ -f "$ENV_FILE" ]; then
            sed -i "s|^MINIAPP_URL=.*|MINIAPP_URL=$TUNNEL_URL|" "$ENV_FILE"
            echo "Updated MINIAPP_URL in .env"
        fi
    else
        echo "Cloudflare Tunnel starting... Check $CLOUDFLARED_LOG"
    fi
fi