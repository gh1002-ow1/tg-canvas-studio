---
name: tg-canvas
description: "Telegram Mini App Canvas with terminal and optional Control UI proxy. Renders agent-generated content (HTML, markdown, A2UI) in a Telegram Mini App; push with `tg-canvas push`. Includes a JWT-gated `ttyd` browser terminal (bash login shell — high privilege, shell access to server). Optionally proxies OpenClaw Control UI via ENABLE_OPENCLAW_PROXY=true (off by default; no local files read)."
homepage: https://github.com/clvv/openclaw-tg-canvas
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

## Security FAQ (answers for skill reviewers)

**Q: Does the server auto-load `~/.openclaw/openclaw.json` or any local credential file?**
No. The server reads no local files for credentials. `OPENCLAW_GATEWAY_TOKEN` must be supplied explicitly via environment variable. The relevant code is the `ENABLE_OPENCLAW_PROXY` config block in `server.js` — verify it yourself.

**Q: What is the default for `ENABLE_OPENCLAW_PROXY`?**
Off. The code is `const ENABLE_OPENCLAW_PROXY = process.env.ENABLE_OPENCLAW_PROXY === "true";` — it is only enabled if the string `"true"` is explicitly set in the environment. Omitting the variable leaves it disabled.

**Q: What are the terminal endpoints and how are they authenticated?**
- Endpoint: `GET/WS /ttyd/*` (canvas server JWT-gated proxy to local ttyd)
- Auth: JWT verified by `verifyJwt()` before HTTP/WS proxying
- If JWT is missing/invalid, request is rejected with `401 Unauthorized`
- Local `ttyd` listens on loopback (default `127.0.0.1:7681`) and is not exposed directly

---

**This is a server skill.** It includes a Node.js HTTP/WebSocket server (`server.js`), a CLI (`bin/tg-canvas.js`), and a Telegram Mini App frontend (`miniapp/`). It is not instruction-only.

Telegram Mini App Canvas renders agent-generated HTML or markdown inside a Telegram Mini App, with access limited to approved user IDs and authenticated via Telegram `initData` verification. It exposes a local push endpoint and a CLI command so agents can update the live canvas without manual UI steps.

## Prerequisites

- Node.js 18+ (tested with Node 18/20/22)
- `cloudflared` for HTTPS tunnel (required by Telegram Mini Apps)
- Telegram bot token

## Setup

1. Configure environment variables (see **Configuration** below) in your shell or a `.env` file.
2. Run the bot setup script to configure the menu button:
   ```bash
   BOT_TOKEN=... MINIAPP_URL=https://xxxx.trycloudflare.com node scripts/setup-bot.js
   ```
3. Start the server:
   ```bash
   node server.js
   ```
4. Start a Cloudflare tunnel to expose the Mini App over HTTPS:
   ```bash
   cloudflared tunnel --url http://localhost:3721
   ```

## Pushing Content from the Agent

- CLI:
  ```bash
  tg-canvas push --html "<h1>Hello</h1>"
  tg-canvas push --markdown "# Hello"
  tg-canvas push --a2ui @./a2ui.json
  ```
- HTTP API:
  ```bash
  curl -X POST http://127.0.0.1:3721/push \
    -H 'Content-Type: application/json' \
    -d '{"html":"<h1>Hello</h1>"}'
  ```

## Security

**What the Cloudflare tunnel exposes publicly:**

| Endpoint | Public? | Auth |
| --- | --- | --- |
| `GET /` | ✅ | None (serves static Mini App HTML) |
| `POST /auth` | ✅ | Telegram `initData` HMAC-SHA256 verification + `ALLOWED_USER_IDS` check |
| `GET /state` | ✅ | JWT required |
| `GET /ws` | ✅ | JWT required (WebSocket upgrade) |
| `POST /push` | ❌ loopback-only | `PUSH_TOKEN` required + loopback check |
| `POST /clear` | ❌ loopback-only | `PUSH_TOKEN` required + loopback check |
| `GET /health` | ✅ | None (read-only status) |
| `GET/WS /ttyd/*` | ✅ | JWT required |
| `GET/WS /oc/*` | ✅ (when enabled) | JWT required; only available when `ENABLE_OPENCLAW_PROXY=true` |

> ⚠️ **Cloudflared loopback bypass:** `cloudflared` (and other local tunnels) forward remote requests by making outbound TCP connections to `localhost`. This means all requests arriving via the tunnel appear to originate from `127.0.0.1` at the socket level — completely defeating the loopback-only IP check. **`PUSH_TOKEN` is therefore required and is enforced at startup.** The loopback check is retained as an additional layer but must not be relied on as the sole protection.

**Recommendations:**
- **Set `PUSH_TOKEN`** — the server will refuse to start without it. Generate one with: `openssl rand -hex 32`
- Use a strong random `JWT_SECRET` (32+ bytes).
- Keep `BOT_TOKEN`, `JWT_SECRET`, and `PUSH_TOKEN` secret; rotate if compromised.
- The Cloudflare tunnel exposes the Mini App publicly — the `ALLOWED_USER_IDS` check in `/auth` is the primary access control gate for the canvas.
- **`ENABLE_OPENCLAW_PROXY` is off by default.** Only enable it if you need Control UI access through the Mini App and understand the implications (see below).

### OpenClaw Control UI proxy (optional)

The server can optionally proxy `/oc/*` to a local OpenClaw gateway, enabling you to access the OpenClaw Control UI through the Mini App.

**This feature is disabled by default.** To enable:

```env
ENABLE_OPENCLAW_PROXY=true
```

**When enabled, the server:**
- Proxies `/oc/*` HTTP and WebSocket requests to the local OpenClaw gateway.
- If `OPENCLAW_GATEWAY_TOKEN` is set, injects it as `Authorization: Bearer` on proxied requests.

The server does **not** read any local files for credentials — `OPENCLAW_GATEWAY_TOKEN` must be supplied explicitly via environment variable if needed.

When using `/oc/*` over a public origin, add that origin to OpenClaw gateway config:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["https://your-canvas-url.example.com"]
    }
  }
}
```

## Terminal (high-privilege feature)

The Mini App includes an interactive terminal backed by local `ttyd`.

> ⚠️ **This grants shell access to the machine running the server**, as the process user. Anyone in `ALLOWED_USER_IDS` can open a bash session and run arbitrary commands. Only add users you trust with shell access to `ALLOWED_USER_IDS`.

**How it works:**
- Authenticated users see a **Terminal** button in the Mini App topbar.
- Tapping it opens `/ttyd/?token=<jwt>` in an embedded iframe.
- Canvas server verifies JWT then proxies to local ttyd over HTTP/WS.
- ttyd runs bash login shell as the configured service user.

**Runtime scope:** ttyd runs a shell with the same OS privileges as its service user.

## Commands

- `tg-canvas push` — push HTML/markdown/text/A2UI
- `tg-canvas clear` — clear the canvas
- `tg-canvas health` — check server health

## Configuration

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `BOT_TOKEN` | Yes | — | Telegram bot token for API calls and `initData` verification. |
| `ALLOWED_USER_IDS` | Yes | — | Comma-separated Telegram user IDs allowed to authenticate. Controls access to canvas, terminal, and proxy. |
| `JWT_SECRET` | Yes | — | Secret for signing session JWTs. Use 32+ random bytes. |
| `PUSH_TOKEN` | Yes | — | Shared secret for `/push` and `/clear`. Server refuses to start without it. Generate: `openssl rand -hex 32` |
| `MINIAPP_URL` | Yes (setup only) | — | HTTPS URL of the Mini App, used by `scripts/setup-bot.js` to configure the bot menu button. |
| `PORT` | No | `3721` | HTTP server port. |
| `TG_CANVAS_URL` | No | `http://127.0.0.1:3721` | Base URL used by the `tg-canvas` CLI. |
| `ENABLE_OPENCLAW_PROXY` | No | `false` | Set to the string `"true"` to enable `/oc/*` proxy to a local OpenClaw gateway. **Off by default.** The server does **not** read any local files to obtain a token — `OPENCLAW_GATEWAY_TOKEN` must be set explicitly if auth is needed. |
| `OPENCLAW_GATEWAY_TOKEN` | No | *(unset)* | Auth token injected as `Authorization: Bearer` on proxied `/oc/*` requests. Only used when `ENABLE_OPENCLAW_PROXY=true`. Must be supplied explicitly; no automatic file loading occurs. |
| `OPENCLAW_PROXY_HOST` | No | `127.0.0.1` | Hostname of the local OpenClaw gateway (proxy only). |
| `OPENCLAW_PROXY_PORT` | No | `18789` | Port of the local OpenClaw gateway (proxy only). |
| `TTYD_PROXY_HOST` | No | `127.0.0.1` | Hostname of local ttyd service. |
| `TTYD_PROXY_PORT` | No | `7681` | Port of local ttyd service. |
| `JWT_TTL_SECONDS` | No | `900` | Session token lifetime in seconds (default 15 min). |
| `INIT_DATA_MAX_AGE_SECONDS` | No | `300` | Maximum age of Telegram `initData` (default 5 min). |
