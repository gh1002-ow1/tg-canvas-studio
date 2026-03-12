# Local Ops Notes

This file is for machine-local deployment notes only. Keep it generic before sharing the repo.

Recommended local layout:

- repo checkout: `/opt/tg-canvas-studio`
- instance env files: `/etc/tg-canvas/main.env`, `/etc/tg-canvas/bot2.env`
- services: `tg-canvas@main.service`, `ttyd-canvas@main.service`, `cloudflared-canvas@main.service`

Basic checks:

```bash
curl http://127.0.0.1:3721/health
systemctl status tg-canvas@main.service ttyd-canvas@main.service cloudflared-canvas@main.service
journalctl -u tg-canvas@main.service -n 100 --no-pager
```

Local reminders:

- Do not commit real `.env` files.
- Do not store tunnel credential paths, bot handles, or production domains here if the repo may be shared.
- If you need per-instance notes, keep them outside git.
