#!/usr/bin/env bash
set -euo pipefail

# Purpose:
#   Restart the local OpenClaw gateway daemon via the `openclaw` CLI, while
#   ensuring the systemd user bus environment is available.
#
# Usage:
#   ./scripts/openclaw-gateway-restart.sh
#   ./scripts/openclaw-gateway-restart.sh --help
#
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/openclaw-gateway-env.sh
source "${ROOT_DIR}/scripts/openclaw-gateway-env.sh"

exec openclaw gateway restart "$@"
