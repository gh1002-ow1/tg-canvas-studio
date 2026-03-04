#!/usr/bin/env bash
set -euo pipefail

# Purpose:
#   Normalize environment variables needed for `openclaw gateway *` commands to
#   talk to the systemd *user* bus, especially when executed from non-login
#   contexts (e.g., tg-canvas Quick Commands / cron / systemd services).
#
# Usage:
#   source ./scripts/openclaw-gateway-env.sh
#
# Notes:
#   If the user bus socket is missing, enable lingering so the user systemd
#   session stays available without an interactive login:
#     loginctl enable-linger <username>
#
# Ensure systemd user bus variables exist for non-login contexts (e.g. Quick Commands).
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=${XDG_RUNTIME_DIR}/bus}"

if [[ ! -S "${XDG_RUNTIME_DIR}/bus" ]]; then
  echo "systemd user bus not available at ${XDG_RUNTIME_DIR}/bus" >&2
  echo "Run once on host: loginctl enable-linger $(id -un)" >&2
  exit 1
fi
