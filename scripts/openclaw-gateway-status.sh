#!/usr/bin/env bash
set -euo pipefail

# Purpose:
#   Show OpenClaw gateway status via the `openclaw` CLI, while ensuring the
#   systemd user bus environment is available.
#
# Usage:
#   ./scripts/openclaw-gateway-status.sh
#   ./scripts/openclaw-gateway-status.sh --help
#
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/openclaw-gateway-env.sh
source "${ROOT_DIR}/scripts/openclaw-gateway-env.sh"

exec openclaw gateway status "$@"
