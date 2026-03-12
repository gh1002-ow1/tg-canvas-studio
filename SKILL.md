---
name: tg-canvas
description: "Telegram Mini App Canvas server with push API, JWT-gated ttyd terminal, optional OpenClaw proxy, and single-checkout multi-instance deployment."
homepage: https://github.com/gh1002-ow1/tg-canvas-studio
kind: server
metadata:
  {
    "openclaw": {
      "emoji": "🖼️",
      "kind": "server",
      "requires": {
        "bins": ["node", "cloudflared"],
        "env": ["BOT_TOKEN", "ALLOWED_USER_IDS", "JWT_SECRET", "MINIAPP_URL", "PUSH_TOKEN"]
      },
      "install": [
        {
          "id": "npm",
          "kind": "npm",
          "label": "Install dependencies (npm install)"
        }
      ]
    }
  }
---

## What This Skill Ships

- `server.js`: Telegram Mini App backend with HTTP, WebSocket, file APIs, and auth
- `miniapp/`: frontend rendered inside Telegram
- `bin/tg-canvas.js`: push/clear/health CLI
- `systemd/*.service`: template units for one-checkout, many-instance deployment

## Setup

1. Install dependencies:

```bash
npm install
```

2. Configure local env:

```bash
cp .env.example .env
chmod 600 .env
```

3. Set at least:

- `BOT_TOKEN`
- `ALLOWED_USER_IDS`
- `JWT_SECRET`
- `PUSH_TOKEN`
- `MINIAPP_URL`

4. Configure the Telegram bot menu button:

```bash
BOT_TOKEN=... MINIAPP_URL=https://your-miniapp.example.com node scripts/setup-bot.js
```

5. Start the server:

```bash
node server.js
```

6. Expose it over HTTPS:

```bash
cloudflared tunnel --url http://127.0.0.1:3721
```

## Multi-Instance Model

The recommended deployment model is:

- one git checkout
- one env file per instance in `/etc/tg-canvas/%i.env`
- one systemd instance name per bot, such as `main` or `bot2`
- one per-instance state directory under `var/%i/`

Template services:

- `tg-canvas@.service`
- `ttyd-canvas@.service`
- `cloudflared-canvas@.service`

Install and start:

```bash
sudo cp systemd/tg-canvas@.service /etc/systemd/system/
sudo cp systemd/ttyd-canvas@.service /etc/systemd/system/
sudo cp systemd/cloudflared-canvas@.service /etc/systemd/system/
sudo mkdir -p /etc/tg-canvas
sudo cp .env.example /etc/tg-canvas/main.env
sudo chmod 600 /etc/tg-canvas/main.env
sudo systemctl daemon-reload
sudo systemctl enable --now tg-canvas@main.service ttyd-canvas@main.service cloudflared-canvas@main.service
```

Each instance must use distinct values for `BOT_TOKEN`, `PORT`, `TTYD_PORT`, `TTYD_PROXY_PORT`, `JWT_SECRET`, `PUSH_TOKEN`, `CLOUDFLARED_TUNNEL`, and `MINIAPP_URL`.

## Commands

```bash
tg-canvas push --html "<h1>Hello</h1>"
tg-canvas push --markdown "# Hello"
tg-canvas push --a2ui @./a2ui.json
tg-canvas clear
tg-canvas health
```

## Security FAQ

**Does the server auto-load `~/.openclaw/openclaw.json` or any local credential file?**

No. `OPENCLAW_GATEWAY_TOKEN` must be supplied explicitly via environment variable.

**What is the default for `ENABLE_OPENCLAW_PROXY`?**

Off. It only enables when the environment variable is exactly `true`.

**How are terminal sessions protected?**

`/ttyd/*` is proxied only after JWT verification. Local `ttyd` stays bound to loopback.

**Why is `PUSH_TOKEN` mandatory?**

Because tunnels such as `cloudflared` make remote requests appear to come from localhost. The loopback IP check alone is not enough.

## Key Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | - | Telegram bot token. |
| `ALLOWED_USER_IDS` | Yes | - | Allowed Telegram user IDs. |
| `JWT_SECRET` | Yes | - | JWT signing secret. |
| `PUSH_TOKEN` | Yes | - | Required secret for `/push` and `/clear`. |
| `MINIAPP_URL` | Setup only | - | HTTPS Mini App URL for menu-button setup. |
| `PORT` | No | `3721` | Canvas server port. |
| `TG_CANVAS_URL` | No | `http://127.0.0.1:3721` | CLI target base URL. |
| `TTYD_PORT` | No | `7681` | Local ttyd port. |
| `TTYD_PROXY_PORT` | No | `7681` | Port proxied by the canvas server. |
| `ENABLE_OPENCLAW_PROXY` | No | `false` | Enable `/oc/*` proxy. |
| `OPENCLAW_PROXY_HOST` | No | `127.0.0.1` | OpenClaw gateway host. |
| `OPENCLAW_PROXY_PORT` | No | `18789` | OpenClaw gateway port. |
| `OPENCLAW_GATEWAY_TOKEN` | No | unset | Optional bearer token for the OpenClaw proxy. |
| `TG_CANVAS_DATA_DIR` | No | `./var/<instance>` | Per-instance runtime data directory. |
| `COMMANDS_FILE` | No | `<TG_CANVAS_DATA_DIR>/commands.json` | Per-instance quick commands file. |
