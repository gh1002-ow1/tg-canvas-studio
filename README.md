# Telegram Mini App Canvas

[![ClawHub](https://img.shields.io/badge/ClawHub-openclaw--tg--canvas-blue)](https://clawhub.ai/skills/openclaw-tg-canvas)

Telegram Mini App server for OpenClaw-style workflows. It renders pushed content in a live canvas, optionally exposes a JWT-gated browser terminal via `ttyd`, and can proxy a local OpenClaw Control UI.

Links: [GitHub](https://github.com/gh1002-ow1/tg-canvas-studio) · [ClawHub](https://clawhub.ai/skills/openclaw-tg-canvas)

## Features

1. Canvas rendering: push `html`, `markdown`, `text`, or `a2ui` to connected Mini App clients.
2. Telegram auth: verifies Mini App `initData`, issues short-lived JWTs, and restricts access to `ALLOWED_USER_IDS`.
3. Interactive terminal: optional JWT-gated `/ttyd/*` proxy to a local `ttyd` shell.
4. OpenClaw proxy: optional `/oc/*` HTTP and WebSocket proxy to a local OpenClaw gateway.
5. File browser APIs: tree, read, stat, write, mkdir, delete, and search inside `WORKSPACE_ROOT`.
6. Quick commands: editable UI commands with `editable` or `safe` execution mode.
7. Multi-instance deployment: one code checkout can host multiple bots via instance-specific env files.

## Repo Layout

- `server.js`: HTTP/WebSocket server
- `miniapp/`: Telegram Mini App frontend
- `bin/tg-canvas.js`: local CLI for push/clear/health
- `systemd/*.service`: template units for multi-instance deployment
- `.env.example`: config template

## Quick Start

1. Clone and install:

```bash
git clone https://github.com/gh1002-ow1/tg-canvas-studio.git
cd tg-canvas-studio
npm install
```

2. Create local config:

```bash
cp .env.example .env
chmod 600 .env
```

3. Fill at least these variables in `.env`:

- `BOT_TOKEN`
- `ALLOWED_USER_IDS`
- `JWT_SECRET`
- `PUSH_TOKEN`
- `TG_CANVAS_URL`
- `MINIAPP_URL`

4. Start locally:

```bash
node server.js
```

5. Expose HTTPS for Telegram Mini Apps:

```bash
cloudflared tunnel --url http://127.0.0.1:3721
```

6. Configure the bot menu button:

```bash
BOT_TOKEN=... MINIAPP_URL=https://your-miniapp.example.com node scripts/setup-bot.js
```

For local development with a quick tunnel, `scripts/start.sh` can start the server and print a `trycloudflare.com` URL.

## Required Configuration

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | - | Telegram bot token used for API calls and Mini App auth verification. |
| `ALLOWED_USER_IDS` | Yes | - | Comma-separated Telegram user IDs allowed to authenticate. |
| `JWT_SECRET` | Yes | - | Secret used to sign session JWTs. If omitted, the server will generate one under the instance data dir. |
| `PUSH_TOKEN` | Yes | - | Required for `/push` and `/clear`. The server exits if missing. |
| `MINIAPP_URL` | Setup only | - | HTTPS URL used by `scripts/setup-bot.js`. |
| `TG_CANVAS_URL` | No | `http://127.0.0.1:3721` | Base URL used by the `tg-canvas` CLI. |
| `PORT` | No | `3721` | HTTP listen port. |
| `WORKSPACE_ROOT` | No | `$HOME` | Root for file APIs and command execution cwd. |
| `ALLOW_COMMANDS_WRITE` | No | `false` | Set `true` to allow editing quick commands from the UI. |
| `COMMAND_EXECUTION_MODE` | No | `editable` | `editable` runs saved command text; `safe` runs only fixed mappings. |
| `COMMAND_RUN_ALLOWLIST` | No | empty | Comma-separated command ids for `safe` mode; `*` allows all fixed ids. |
| `TTYD_PORT` | No | `7681` | Local ttyd listen port. |
| `TTYD_PROXY_PORT` | No | `7681` | Port the canvas server proxies `/ttyd/*` to. |
| `ENABLE_OPENCLAW_PROXY` | No | `false` | Enables `/oc/*` proxy only when set to the string `true`. |
| `OPENCLAW_PROXY_HOST` | No | `127.0.0.1` | Local OpenClaw gateway host. |
| `OPENCLAW_PROXY_PORT` | No | `18789` | Local OpenClaw gateway port. |
| `OPENCLAW_GATEWAY_TOKEN` | No | unset | Optional bearer token injected into proxied OpenClaw requests. |
| `TG_CANVAS_DATA_DIR` | No | `./var/<instance>` | Stores per-instance generated JWT secret and quick commands. |
| `COMMANDS_FILE` | No | `<TG_CANVAS_DATA_DIR>/commands.json` | Per-instance quick command storage. |

## Security

Public endpoints exposed through your HTTPS ingress:

| Endpoint | Auth |
| --- | --- |
| `GET /` | none |
| `POST /auth` | Telegram `initData` verification + `ALLOWED_USER_IDS` |
| `GET /state` | JWT |
| `GET /ws` | JWT |
| `POST /push` | `PUSH_TOKEN` + loopback |
| `POST /clear` | `PUSH_TOKEN` + loopback |
| `GET /health` | none |
| `GET/WS /ttyd/*` | JWT |
| `GET/WS /oc/*` | JWT, only when proxy enabled |

Important:

- `PUSH_TOKEN` is mandatory because tunnels like `cloudflared` make remote requests appear as loopback traffic.
- The terminal is high privilege. Anyone in `ALLOWED_USER_IDS` can open a shell as the service user.
- `ENABLE_OPENCLAW_PROXY` is off by default.
- No local credential files are auto-read for the OpenClaw proxy. If needed, pass `OPENCLAW_GATEWAY_TOKEN` explicitly.

## CLI

Examples:

```bash
tg-canvas push --html "<h1>Hello</h1>"
tg-canvas push --markdown "# Hello"
tg-canvas push --a2ui @./a2ui.json
tg-canvas clear
tg-canvas health
```

Direct HTTP:

```bash
curl -X POST http://127.0.0.1:3721/push \
  -H 'Content-Type: application/json' \
  -H 'X-Push-Token: your_push_token' \
  -d '{"markdown":"# Hello"}'
```

## Multi-Instance Deployment

This repo now supports an elegant single-checkout, multi-bot model:

- one git checkout
- one shared `miniapp/` and codebase
- one env file per instance under `/etc/tg-canvas/`
- one systemd instance name per bot, such as `main`, `bot2`, `support`

Each instance needs unique values for:

- `BOT_TOKEN`
- `ALLOWED_USER_IDS`
- `PORT`
- `TTYD_PORT`
- `TTYD_PROXY_PORT`
- `PUSH_TOKEN`
- `JWT_SECRET`
- `CLOUDFLARED_TUNNEL`
- `MINIAPP_URL`
- optional `TG_CANVAS_URL`

### Install Template Units

```bash
bash scripts/install-systemd-instance.sh
```

By default the installer renders the units for the current checkout path and current user. Override if needed:

```bash
bash scripts/install-systemd-instance.sh --user deploy --root /opt/tg-canvas-studio
```

### Create Instance Configs

```bash
sudo cp .env.example /etc/tg-canvas/main.env
sudo cp .env.example /etc/tg-canvas/bot2.env
sudo chmod 600 /etc/tg-canvas/main.env /etc/tg-canvas/bot2.env
```

Edit the values so ports, secrets, bot tokens, and tunnel names differ.

### Start Instances

```bash
sudo systemctl enable --now tg-canvas@main.service ttyd-canvas@main.service cloudflared-canvas@main.service
sudo systemctl enable --now tg-canvas@bot2.service ttyd-canvas@bot2.service cloudflared-canvas@bot2.service
```

This works because the template units read `/etc/tg-canvas/%i.env`, and `server.js` stores per-instance state under `var/%i/`.

### Migrating from Legacy Single-Service Setup

If you previously created a plain `tg-canvas.service`, do not run it alongside `tg-canvas@main.service`. They will fight for the same port.

Recommended migration:

```bash
sudo systemctl disable --now tg-canvas.service
sudo systemctl enable --now tg-canvas@main.service
```

Keep only one startup model.

## OpenClaw Proxy

Enable explicitly:

```env
ENABLE_OPENCLAW_PROXY=true
OPENCLAW_PROXY_HOST=127.0.0.1
OPENCLAW_PROXY_PORT=18789
OPENCLAW_GATEWAY_TOKEN=...
```

If your OpenClaw Control UI enforces origin checks, add the Mini App origin to the gateway config:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["https://your-miniapp.example.com"]
    }
  }
}
```

## Notes for Public Distribution

- Real secrets belong in `.env` or `/etc/tg-canvas/*.env`, never in git.
- `logs/` and `var/` are ignored by git.
- The tracked `README.local.md` is intentionally generic and should stay free of deployment-specific values.

## Health Check

```bash
curl http://127.0.0.1:3721/health
```

Example response:

```json
{"ok":true,"uptime":123.4,"clients":0,"hasState":false}
```
