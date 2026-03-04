#!/usr/bin/env bash
set -euo pipefail

# 用途: 重启 TG Canvas 相关服务
# 使用方法:
#   1) 仅重启主服务:
#      ./scripts/restart-services.sh tg
#   2) 同时重启 canvas + ttyd + cloudflared:
#      ./scripts/restart-services.sh all
#   3) 不传参数默认重启 all
# 注意:
#   - 需要 sudo 权限（systemctl restart）
#   - service 名称使用 @main 实例：tg-canvas@main / ttyd-canvas@main / cloudflared-canvas@main
#   - 如果你只部署了部分服务，使用 tg 模式即可

MODE="${1:-all}"

case "$MODE" in
  tg)
    sudo systemctl restart tg-canvas@main.service
    ;;
  all)
    sudo systemctl restart tg-canvas@main.service ttyd-canvas@main.service cloudflared-canvas@main.service
    ;;
  *)
    echo "未知参数: $MODE" >&2
    echo "可用参数: tg | all" >&2
    exit 1
    ;;
 esac

# 显示状态(简要)
systemctl status tg-canvas@main.service --no-pager | sed -n '1,20p'
if [ "$MODE" = "all" ]; then
  systemctl status ttyd-canvas@main.service cloudflared-canvas@main.service --no-pager | sed -n '1,20p'
fi
