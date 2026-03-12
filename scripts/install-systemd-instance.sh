#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_USER="${SUDO_USER:-${USER}}"
PROJECT_ROOT="$ROOT_DIR"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user)
      SERVICE_USER="${2:?missing value for --user}"
      shift 2
      ;;
    --root)
      PROJECT_ROOT="${2:?missing value for --root}"
      shift 2
      ;;
    *)
      echo "Usage: $0 [--user <service-user>] [--root <project-root>]" >&2
      exit 1
      ;;
  esac
done

if [[ ! -d "$PROJECT_ROOT" ]]; then
  echo "Project root does not exist: $PROJECT_ROOT" >&2
  exit 1
fi

render_unit() {
  local src="$1"
  local dest="$2"
  sed \
    -e "s|User=joker|User=${SERVICE_USER}|g" \
    -e "s|Group=joker|Group=${SERVICE_USER}|g" \
    -e "s|/home/joker/projects/tg-canvas-studio|${PROJECT_ROOT}|g" \
    -e "s|/home/joker|$(getent passwd "${SERVICE_USER}" | cut -d: -f6)|g" \
    "$src" | sudo tee "$dest" >/dev/null
}

render_unit "$ROOT_DIR/systemd/tg-canvas@.service" /etc/systemd/system/tg-canvas@.service
render_unit "$ROOT_DIR/systemd/ttyd-canvas@.service" /etc/systemd/system/ttyd-canvas@.service
render_unit "$ROOT_DIR/systemd/cloudflared-canvas@.service" /etc/systemd/system/cloudflared-canvas@.service

sudo mkdir -p /etc/tg-canvas
sudo systemctl daemon-reload

echo "Installed template units for user '$SERVICE_USER' and project root '$PROJECT_ROOT'."
echo "Next:"
echo "  sudo cp $ROOT_DIR/.env.example /etc/tg-canvas/main.env"
echo "  sudo chmod 600 /etc/tg-canvas/main.env"
