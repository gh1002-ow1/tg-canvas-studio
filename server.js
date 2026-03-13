#!/usr/bin/env node
"use strict";

// Telegram Mini App Canvas server
// - HTTP server for static files + REST endpoints
// - WebSocket server for pushing canvas updates

const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { exec, execSync } = require("child_process");
const { WebSocketServer } = require("ws");

// ---- Config ----
const PROJECT_ROOT = __dirname;
const INSTANCE_NAME = (process.env.TG_CANVAS_INSTANCE || process.env.INSTANCE_NAME || "main").trim() || "main";
const LOG_DIR = process.env.TG_CANVAS_LOG_DIR || path.join(PROJECT_ROOT, "logs");
const DATA_DIR = process.env.TG_CANVAS_DATA_DIR || path.join(PROJECT_ROOT, "var", INSTANCE_NAME);
const COMMANDS_FILE = process.env.COMMANDS_FILE || path.join(DATA_DIR, "commands.json");
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
function loadJwtSecret() {
  const fromEnv = (process.env.JWT_SECRET || "").trim();
  if (fromEnv) return fromEnv;

  const secretPath = process.env.JWT_SECRET_FILE || path.join(DATA_DIR, ".jwt-secret");
  try {
    if (fs.existsSync(secretPath)) {
      const existing = fs.readFileSync(secretPath, "utf8").trim();
      if (existing) return existing;
    }
  } catch (_) {
    // Fall through to generating a secret (best-effort).
  }

  const generated = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(secretPath, `${generated}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    console.warn(`[tg-canvas] JWT_SECRET not set; generated and persisted secret at ${secretPath}`);
  } catch (_) {
    console.warn("[tg-canvas] JWT_SECRET not set; using ephemeral in-memory secret (tokens will break on restart)");
  }
  return generated;
}

const JWT_SECRET = loadJwtSecret();
const JWT_TTL_SECONDS = parseInt(process.env.JWT_TTL_SECONDS || "900", 10); // 15m
const INIT_DATA_MAX_AGE_SECONDS = parseInt(process.env.INIT_DATA_MAX_AGE_SECONDS || "300", 10); // 5m
const PORT = parseInt(process.env.PORT || "3721", 10);
const PUSH_TOKEN = process.env.PUSH_TOKEN || ""; // required — server will refuse /push and /clear without it
const RATE_LIMIT_AUTH_PER_MIN = parseInt(process.env.RATE_LIMIT_AUTH_PER_MIN || "30", 10);
const RATE_LIMIT_STATE_PER_MIN = parseInt(process.env.RATE_LIMIT_STATE_PER_MIN || "120", 10);
// OpenClaw Control UI proxy — OFF by default; must be explicitly opted into.
// When enabled, /oc/* HTTP and WebSocket requests are proxied to the local
// OpenClaw gateway. If OPENCLAW_GATEWAY_TOKEN is set, it is injected as an
// Authorization: Bearer header on proxied requests. No local credential files
// are read; OPENCLAW_GATEWAY_TOKEN must be supplied explicitly via env var.
const ENABLE_OPENCLAW_PROXY = process.env.ENABLE_OPENCLAW_PROXY === "true";
const OPENCLAW_PROXY_HOST = process.env.OPENCLAW_PROXY_HOST || "127.0.0.1";
const OPENCLAW_PROXY_PORT = parseInt(process.env.OPENCLAW_PROXY_PORT || "18789", 10);
let OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "";
const TTYD_PROXY_HOST = process.env.TTYD_PROXY_HOST || "127.0.0.1";
const TTYD_PROXY_PORT = parseInt(process.env.TTYD_PROXY_PORT || "7681", 10);
const ALLOW_COMMANDS_WRITE = process.env.ALLOW_COMMANDS_WRITE === "true";
const COMMAND_EXECUTION_MODE = (process.env.COMMAND_EXECUTION_MODE || "editable").trim().toLowerCase();
const COMMAND_RUN_ALLOWLIST_RAW = String(process.env.COMMAND_RUN_ALLOWLIST || "").trim();
const COMMAND_RUN_ALLOW_ALL = COMMAND_RUN_ALLOWLIST_RAW === "*";
const COMMAND_RUN_ALLOWLIST = new Set(
  COMMAND_RUN_ALLOWLIST_RAW
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

function resolveAppVersion() {
  const fromEnv = String(process.env.TG_CANVAS_VERSION || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch (_) {
    return "dev";
  }
}

const APP_VERSION = resolveAppVersion();

function resolveWorkspaceRoot() {
  const configured = String(process.env.WORKSPACE_ROOT || "").trim();
  const candidates = [configured, PROJECT_ROOT].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const resolved = path.resolve(candidate);
      const stats = fs.statSync(resolved);
      if (stats.isDirectory()) return resolved;
    } catch (_) {
      // Try next candidate.
    }
  }
  return PROJECT_ROOT;
}

const WORKSPACE_ROOT = resolveWorkspaceRoot();

function fixedCommandById(commandId, workspaceRoot) {
  const root = workspaceRoot || process.env.HOME || "/";
  const projectLogs = LOG_DIR;
  const gatewayStatusScript = `${JSON.stringify(process.env.TG_CANVAS_ROOT || PROJECT_ROOT)}/scripts/openclaw-gateway-status.sh`;
  const gatewayRestartScript = `${JSON.stringify(process.env.TG_CANVAS_ROOT || PROJECT_ROOT)}/scripts/openclaw-gateway-restart.sh`;
  const map = {
    "git-status": `cd ${JSON.stringify(root)} && git status`,
    "git-log": `cd ${JSON.stringify(root)} && git log --oneline -10`,
    "ogs": `bash ${gatewayStatusScript} --deep`,
    "ogr": `bash ${gatewayRestartScript}`,
    "openclaw-status": "openclaw models status",
    "server-logs": `tail -50 ${JSON.stringify(path.join(projectLogs, `tg-canvas-${INSTANCE_NAME}.log`))}`,
    "check-services": "systemctl --no-pager --type=service --state=running | rg -n \"(tg-canvas|ttyd-canvas|cloudflared-canvas)\" || true",
  };
  return map[commandId] || "";
}

function fixedCommandByAlias(commandText, workspaceRoot) {
  const root = workspaceRoot || process.env.HOME || "/";
  const projectLogs = LOG_DIR;
  const gatewayStatusScript = `${JSON.stringify(process.env.TG_CANVAS_ROOT || PROJECT_ROOT)}/scripts/openclaw-gateway-status.sh`;
  const gatewayRestartScript = `${JSON.stringify(process.env.TG_CANVAS_ROOT || PROJECT_ROOT)}/scripts/openclaw-gateway-restart.sh`;
  const normalized = String(commandText || "").trim().toLowerCase().replace(/\s+/g, " ");
  const map = {
    "ogs": `bash ${gatewayStatusScript} --deep`,
    "ogr": `bash ${gatewayRestartScript}`,
    "openclaw gateway status": `bash ${gatewayStatusScript}`,
    "openclaw gateway status --deep": `bash ${gatewayStatusScript} --deep`,
    "openclaw gateway restart": `bash ${gatewayRestartScript}`,
    [`bash ${gatewayStatusScript}`.toLowerCase()]: `bash ${gatewayStatusScript}`,
    [`bash ${gatewayStatusScript} --deep`.toLowerCase()]: `bash ${gatewayStatusScript} --deep`,
    [`bash ${gatewayRestartScript}`.toLowerCase()]: `bash ${gatewayRestartScript}`,
    "openclaw models status": "openclaw models status",
    "git status": `cd ${JSON.stringify(root)} && git status`,
    "git log --oneline -10": `cd ${JSON.stringify(root)} && git log --oneline -10`,
    [`tail -50 tg-canvas-${INSTANCE_NAME}.log`]: `tail -50 ${JSON.stringify(path.join(projectLogs, `tg-canvas-${INSTANCE_NAME}.log`))}`,
  };
  return map[normalized] || "";
}

// ---- Startup validation ----
// PUSH_TOKEN is required because cloudflared (and similar tunnels) forward
// remote requests as loopback TCP connections, bypassing the IP-based loopback
// check entirely. Without a PUSH_TOKEN, anyone who discovers the public tunnel
// URL can call /push and /clear.
if (!PUSH_TOKEN) {
  console.error(
    "[FATAL] PUSH_TOKEN is not set. Set PUSH_TOKEN to a strong random secret before starting the server.\n" +
    "        The loopback-only check is NOT sufficient when using cloudflared or any other local tunnel,\n" +
    "        because the tunnel connects to the server via localhost, making all remote requests appear\n" +
    "        to originate from 127.0.0.1. PUSH_TOKEN is your only protection for /push and /clear."
  );
  process.exit(1);
}

if (ENABLE_OPENCLAW_PROXY) {
  console.log(`[tg-canvas] OPENCLAW_PROXY enabled (OPENCLAW_GATEWAY_TOKEN: ${OPENCLAW_GATEWAY_TOKEN ? 'set' : 'not set'})`);
} else {
  console.log('[tg-canvas] OPENCLAW_PROXY disabled (set ENABLE_OPENCLAW_PROXY=true to enable)');
}
console.log(`[tg-canvas] INSTANCE_NAME=${INSTANCE_NAME}`);
console.log(`[tg-canvas] DATA_DIR=${DATA_DIR}`);
console.log(`[tg-canvas] WORKSPACE_ROOT: ${WORKSPACE_ROOT}`);
console.log(`[tg-canvas] APP_VERSION=${APP_VERSION}`);
if (COMMAND_RUN_ALLOW_ALL) {
  console.log("[tg-canvas] COMMAND_RUN_ALLOWLIST=* (all terminal commands allowed)");
} else {
  console.log(`[tg-canvas] COMMAND_RUN_ALLOWLIST entries: ${COMMAND_RUN_ALLOWLIST.size}`);
}
console.log(`[tg-canvas] COMMAND_EXECUTION_MODE=${COMMAND_EXECUTION_MODE}`);

// ---- Helpers ----
const MINIAPP_DIR = path.join(__dirname, "miniapp");
const DEFAULT_COMMANDS_PATH = path.join(MINIAPP_DIR, "commands.json");

function bundledCommandsConfig() {
  try {
    const bundled = fs.readFileSync(DEFAULT_COMMANDS_PATH, "utf8");
    return JSON.parse(bundled || "{}");
  } catch (_) {
    return { commands: [] };
  }
}

function readInstanceCommandsConfig() {
  try {
    if (!fs.existsSync(COMMANDS_FILE)) return null;
    const data = fs.readFileSync(COMMANDS_FILE, "utf8");
    return JSON.parse(data || "{}");
  } catch (_) {
    return null;
  }
}

function sanitizeCommandsConfig(config) {
  const workspaceRoot = WORKSPACE_ROOT;
  const bundled = bundledCommandsConfig();
  const bundledById = new Map((bundled.commands || []).map((cmd) => [cmd.id, cmd]));
  const input = Array.isArray(config?.commands) ? config.commands : [];
  const out = [];
  const seen = new Set();

  for (const rawCmd of input) {
    if (!rawCmd || !rawCmd.id || !rawCmd.type || !rawCmd.label) continue;
    const cmd = { ...rawCmd };

    if (cmd.type === "navigate") {
      const rawPath = String(cmd.path || "").trim();
      if (!rawPath) continue;
      if (path.isAbsolute(rawPath)) {
        const normalizedAbs = path.resolve(rawPath);
        if (!normalizedAbs.startsWith(workspaceRoot)) continue;
        const rel = path.relative(workspaceRoot, normalizedAbs);
        cmd.path = rel || ".";
      }
    } else if (cmd.type === "terminal") {
      const commandText = String(cmd.command || "").trim();
      if (!commandText) continue;
      if (/openclaw-gateway-(status|restart)\.sh/.test(commandText)) {
        continue;
      }
    } else {
      continue;
    }

    if (seen.has(cmd.id)) continue;
    seen.add(cmd.id);
    out.push(cmd);
  }

  for (const bundledCmd of bundled.commands || []) {
    if (!seen.has(bundledCmd.id)) out.push(bundledCmd);
  }

  return { commands: out };
}

function normalizedProxyOrigin() {
  return `http://${OPENCLAW_PROXY_HOST}:${OPENCLAW_PROXY_PORT}`;
}

function readCommandsConfig() {
  const defaults = sanitizeCommandsConfig(bundledCommandsConfig());
  const instanceConfig = readInstanceCommandsConfig();
  const commands = instanceConfig ? sanitizeCommandsConfig(instanceConfig) : defaults;
  return {
    commands: commands.commands || [],
    defaults: defaults.commands || [],
    hasLocalOverride: !!instanceConfig,
    storage: {
      template: DEFAULT_COMMANDS_PATH,
      override: COMMANDS_FILE,
    },
  };
}

function isLoopbackAddress(addr) {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-TG-Canvas-Version": APP_VERSION,
  });
  res.end(body);
}

function readProcText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (_) {
    return null;
  }
}

function readBodyJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        // 1MB limit
        req.destroy();
        reject(new Error("Body too large"));
      }
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(data || "{}");
        resolve(parsed);
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function base64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function signJwt(payload) {
  const header = { alg: "HS256", typ: "JWT" };
  const headerB64 = base64url(JSON.stringify(header));
  const payloadB64 = base64url(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const sig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
  return `${data}.${sig}`;
}

function verifyJwt(token) {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sig] = parts;
    const data = `${headerB64}.${payloadB64}`;
    const expectedSig = crypto.createHmac("sha256", JWT_SECRET).update(data).digest("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
    const payloadJson = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString();
    const payload = JSON.parse(payloadJson);
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp) return null;
    if (now > payload.exp) return null;
    if (payload.iat && payload.iat > now + 60) return null;
    return payload;
  } catch (err) {
    return null;
  }
}

function verifyTelegramInitData(initData) {
  if (!BOT_TOKEN) {
    return { ok: false, error: "BOT_TOKEN not configured" };
  }
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "Missing hash" };

  // Build data check string
  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push([key, value]);
  }
  pairs.sort((a, b) => a[0].localeCompare(b[0]));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  // HMAC-SHA256 per Telegram spec:
  // secret_key = HMAC-SHA256(key="WebAppData", data=BOT_TOKEN)
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (computedHash !== hash) {
    return { ok: false, error: "Invalid initData hash" };
  }

  const userRaw = params.get("user");
  let user = null;
  try {
    user = userRaw ? JSON.parse(userRaw) : null;
  } catch (_) {
    return { ok: false, error: "Invalid user JSON" };
  }

  if (!user || typeof user.id === "undefined") {
    return { ok: false, error: "Missing user.id" };
  }

  if (!ALLOWED_USER_IDS.includes(String(user.id))) {
    return { ok: false, error: "User not allowed" };
  }

  const authDate = parseInt(params.get("auth_date") || "0", 10);
  if (!authDate) {
    return { ok: false, error: "Missing auth_date" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (authDate > nowSec + 60) {
    return { ok: false, error: "auth_date is in the future" };
  }
  if (nowSec - authDate > INIT_DATA_MAX_AGE_SECONDS) {
    return { ok: false, error: "initData expired" };
  }

  const replayKey = `${user.id}:${authDate}:${hash}`;
  if (isInitDataReplayed(replayKey)) {
    return { ok: false, error: "initData replayed" };
  }
  markInitDataUsed(replayKey, INIT_DATA_MAX_AGE_SECONDS);

  return { ok: true, user };
}

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html": return "text/html";
    case ".js": return "text/javascript";
    case ".css": return "text/css";
    case ".json": return "application/json";
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".svg": return "image/svg+xml";
    case ".gif": return "image/gif";
    default: return "application/octet-stream";
  }
}

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const headers = {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-TG-Canvas-Version": APP_VERSION,
    };

    // Telegram WebApp is embedded; allow Telegram origins to frame this app.
    // Note: If a reverse proxy/CDN injects X-Frame-Options: SAMEORIGIN, that must be removed there.
    if (path.extname(filePath).toLowerCase() === ".html") {
      headers["Content-Security-Policy"] =
        "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://t.me https://telegram.me https://*.telegram.org; " +
        "base-uri 'self'; object-src 'none'";
    }

    res.writeHead(200, headers);
    res.end(data);
  });
}

function parseCookies(req) {
  const raw = req.headers.cookie || "";
  const out = {};
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function getJwtFromRequest(req, urlObj) {
  const auth = req.headers["authorization"] || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const queryToken = urlObj.searchParams.get("token") || "";
  const cookies = parseCookies(req);
  const cookieToken = cookies.oc_jwt || cookies.ttyd_jwt || "";
  const referer = String(req.headers.referer || "");
  let refererToken = "";
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      refererToken = refererUrl.searchParams.get("token") || "";
    } catch (_) {
      refererToken = "";
    }
  }
  return bearer || queryToken || cookieToken || refererToken;
}

function patchControlCsp(headersIn) {
  const headers = { ...headersIn };
  const cspKey = Object.keys(headers).find((k) => k.toLowerCase() === 'content-security-policy');
  const xfoKey = Object.keys(headers).find((k) => k.toLowerCase() === 'x-frame-options');
  if (xfoKey) delete headers[xfoKey];
  if (!cspKey) return headers;

  let csp = String(headers[cspKey] || '');
  if (/frame-ancestors\s+[^;]+/.test(csp)) {
    csp = csp.replace(
      /frame-ancestors\s+[^;]+/,
      "frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://t.me https://telegram.me https://*.telegram.org"
    );
  } else {
    csp += "; frame-ancestors 'self' https://web.telegram.org https://webk.telegram.org https://webz.telegram.org https://t.me https://telegram.me https://*.telegram.org";
  }
  // Allow Google Fonts used by control-ui styles without broadly opening script sources.
  if (/style-src\s/.test(csp) && !/fonts\.googleapis\.com/.test(csp)) {
    csp = csp.replace(/style-src\s+([^;]+)/, (m, p1) => `style-src ${p1} https://fonts.googleapis.com`);
  }
  if (/font-src\s/.test(csp)) {
    if (!/fonts\.gstatic\.com/.test(csp)) {
      csp = csp.replace(/font-src\s+([^;]+)/, (m, p1) => `font-src ${p1} https://fonts.gstatic.com data:`);
    }
  } else {
    csp += '; font-src \"self\" https://fonts.gstatic.com data:';
  }
  headers[cspKey] = csp;
  return headers;
}

function proxyToOpenClaw(req, res, targetPath, extraResponseHeaders = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  headers.origin = normalizedProxyOrigin();
  if (OPENCLAW_GATEWAY_TOKEN) {
    headers.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
  }

  const proxyReq = http.request(
    {
      host: OPENCLAW_PROXY_HOST,
      port: OPENCLAW_PROXY_PORT,
      method: req.method,
      path: targetPath,
      headers,
    },
    (proxyRes) => {
      const isConfig = targetPath.startsWith('/__openclaw/control-ui-config.json');
      if (!isConfig) {
        const patchedHeaders = patchControlCsp(proxyRes.headers);
        res.writeHead(proxyRes.statusCode || 502, { ...patchedHeaders, ...extraResponseHeaders });
        proxyRes.pipe(res);
        return;
      }

      let buf = '';
      proxyRes.setEncoding('utf8');
      proxyRes.on('data', (d) => (buf += d));
      proxyRes.on('end', () => {
        try {
          const j = JSON.parse(buf || '{}');
          const host = req.headers.host || '';
          const scheme = /localhost|127\.0\.0\.1/.test(host) ? 'ws' : 'wss';
          j.gatewayUrl = `${scheme}://${host}`;
          const out = JSON.stringify(j);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(out),
            ...extraResponseHeaders,
          });
          res.end(out);
        } catch {
          res.writeHead(proxyRes.statusCode || 502, { ...proxyRes.headers, ...extraResponseHeaders });
          res.end(buf);
        }
      });
    }
  );

  proxyReq.on("error", (err) => {
    console.error("OpenClaw proxy error:", err.message);
    sendJson(res, 502, { error: "OpenClaw proxy unavailable" });
  });

  req.pipe(proxyReq);
}

function proxyToTtyd(req, res, targetPath, extraResponseHeaders = {}) {
  const headers = { ...req.headers };
  delete headers.host;
  const proxyReq = http.request(
    {
      host: TTYD_PROXY_HOST,
      port: TTYD_PROXY_PORT,
      method: req.method,
      path: targetPath,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, { ...proxyRes.headers, ...extraResponseHeaders });
      proxyRes.pipe(res);
    }
  );
  proxyReq.on("error", (err) => {
    console.error("ttyd proxy error:", err.message);
    sendJson(res, 502, { error: "ttyd unavailable" });
  });
  req.pipe(proxyReq);
}

// ---- Simple in-memory rate limiter ----
const rateLimitBuckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + windowMs;
  }
  bucket.count += 1;
  rateLimitBuckets.set(key, bucket);
  return bucket.count <= limit;
}

// ---- initData replay cache ----
const initDataReplay = new Map();
function markInitDataUsed(key, ttlSeconds) {
  const now = Date.now();
  initDataReplay.set(key, now + ttlSeconds * 1000);
}
function isInitDataReplayed(key) {
  const now = Date.now();
  const expires = initDataReplay.get(key);
  if (!expires) return false;
  if (now > expires) {
    initDataReplay.delete(key);
    return false;
  }
  return true;
}

// ---- In-memory canvas state ----
let currentState = null; // { content, format }

// ---- WebSocket management ----
const wsClients = new Set();

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  let count = 0;
  for (const ws of wsClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
      count++;
    }
  }
  return count;
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // Auth-gated proxy to local OpenClaw control UI.
    // Expose via /oc/* through tg-canvas only (JWT required).
    if (ENABLE_OPENCLAW_PROXY && url.pathname.startsWith("/oc/")) {
      const ip = req.socket.remoteAddress || "unknown";
      if (!rateLimit(`oc:${ip}`, RATE_LIMIT_STATE_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }

      const queryToken = url.searchParams.get("token") || "";
      if (queryToken) {
        const qp = verifyJwt(queryToken);
        if (!qp) return sendJson(res, 401, { error: "Invalid token" });
        url.searchParams.delete("token");
        const qs = url.searchParams.toString();
        const targetPath = url.pathname.replace(/^\/oc/, "") + (qs ? `?${qs}` : "");
        return proxyToOpenClaw(req, res, targetPath, {
          "Set-Cookie": `oc_jwt=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${JWT_TTL_SECONDS}`,
        });
      }

      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      // Do not forward auth token query params to the upstream control UI.
      url.searchParams.delete("token");
      const qs = url.searchParams.toString();
      const targetPath = url.pathname.replace(/^\/oc/, "") + (qs ? `?${qs}` : "");
      return proxyToOpenClaw(req, res, targetPath);
    }

    // Support absolute control-ui asset/API paths that may be requested from /oc/ pages.
    // Only proxy when request originated from /oc/ and auth token is valid.
    if (ENABLE_OPENCLAW_PROXY) {
      const ocLikePath =
        url.pathname.startsWith('/assets/') ||
        url.pathname === '/favicon.svg' ||
        url.pathname === '/favicon-32.png' ||
        url.pathname === '/apple-touch-icon.png' ||
        url.pathname.startsWith('/api/') ||
        url.pathname.startsWith('/__openclaw/');
      const referer = req.headers.referer || '';
      if (ocLikePath && referer.includes('/oc/')) {
        const token = getJwtFromRequest(req, url);
        const payload = verifyJwt(token);
        if (!payload) return sendJson(res, 401, { error: 'Invalid token' });
        const qs = url.searchParams.toString();
        const targetPath = url.pathname + (qs ? `?${qs}` : '');
        return proxyToOpenClaw(req, res, targetPath);
      }
    }

    // Auth-gated ttyd proxy under /ttyd/*
    if (url.pathname === "/ttyd" || url.pathname.startsWith("/ttyd/")) {
      const ip = req.socket.remoteAddress || "unknown";
      if (!rateLimit(`ttyd:${ip}`, RATE_LIMIT_STATE_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }

      const queryToken = url.searchParams.get("token") || "";
      if (queryToken) {
        const qp = verifyJwt(queryToken);
        if (!qp) return sendJson(res, 401, { error: "Invalid token" });
        url.searchParams.delete("token");
        const qs = url.searchParams.toString();
        const targetPath = url.pathname + (qs ? `?${qs}` : "");
        return proxyToTtyd(req, res, targetPath, {
          "Set-Cookie": `ttyd_jwt=${encodeURIComponent(queryToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${JWT_TTL_SECONDS}`,
        });
      }

      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });
      const qs = url.searchParams.toString();
      const targetPath = url.pathname + (qs ? `?${qs}` : "");
      return proxyToTtyd(req, res, targetPath);
    }

    // Serve index
    if (req.method === "GET" && url.pathname === "/") {
      const indexPath = path.join(MINIAPP_DIR, "index.html");
      return serveFile(res, indexPath);
    }

    // ---- Quick Commands API ----
    // Must be before static file serving to prevent /api/commands from being served as file
    // GET /api/commands
    if (req.method === "GET" && url.pathname === "/api/commands") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      try {
        return sendJson(res, 200, readCommandsConfig());
      } catch (err) {
        return sendJson(res, 200, {
          commands: [],
          defaults: [],
          hasLocalOverride: false,
          storage: {
            template: DEFAULT_COMMANDS_PATH,
            override: COMMANDS_FILE,
          },
        });
      }
    }

    // POST /api/commands/run
    if (req.method === "POST" && url.pathname === "/api/commands/run") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      try {
        const body = await readBodyJson(req);
        const commandId = String(body.id || "").trim();
        if (!commandId) {
          return sendJson(res, 400, { error: "Missing command id" });
        }

        const parsed = readCommandsConfig();
        const commands = Array.isArray(parsed.commands) ? parsed.commands : [];
        const cmd = commands.find((c) => c && c.id === commandId);
        if (!cmd) {
          return sendJson(res, 404, { error: "Command not found" });
        }
        if (!["terminal", "exec"].includes(cmd.type)) {
          return sendJson(res, 400, { error: "Command is not executable" });
        }
        const workspaceRoot = WORKSPACE_ROOT;
        let execCommand = "";
        if (COMMAND_EXECUTION_MODE === "safe") {
          const fixedById = fixedCommandById(commandId, workspaceRoot);
          const fixedByAlias = fixedCommandByAlias(cmd.command, workspaceRoot);
          if (!COMMAND_RUN_ALLOW_ALL && !COMMAND_RUN_ALLOWLIST.has(commandId) && !fixedByAlias) {
            return sendJson(res, 403, {
              error: "Command id not allowed",
              id: commandId,
              hint: "Set COMMAND_RUN_ALLOWLIST or switch COMMAND_EXECUTION_MODE=editable",
            });
          }
          execCommand = fixedById || fixedByAlias;
          if (!execCommand) {
            return sendJson(res, 403, {
              error: "Command has no fixed safe mapping",
              id: commandId,
            });
          }
        } else {
          execCommand = String(cmd.command || "").trim();
          if (!execCommand) {
            return sendJson(res, 400, { error: "Empty command text" });
          }
        }
        const started = Date.now();
        exec(
          execCommand,
          {
            cwd: workspaceRoot,
            shell: "/bin/bash",
            timeout: 20000,
            maxBuffer: 512 * 1024,
            env: {
              ...process.env,
              TERM: "xterm-256color",
            },
          },
          (err, stdout, stderr) => {
            const durationMs = Date.now() - started;
            if (err) {
              const code = Number.isInteger(err.code) ? err.code : -1;
              return sendJson(res, 200, {
                ok: false,
                id: commandId,
                code,
                durationMs,
                timedOut: !!err.killed,
                stdout: String(stdout || ""),
                stderr: String(stderr || err.message || ""),
              });
            }

            return sendJson(res, 200, {
              ok: true,
              id: commandId,
              code: 0,
              durationMs,
              timedOut: false,
              stdout: String(stdout || ""),
              stderr: String(stderr || ""),
            });
          }
        );
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
      return;
    }

    // POST /api/commands
    if (req.method === "POST" && url.pathname === "/api/commands") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });
      if (!ALLOW_COMMANDS_WRITE) {
        return sendJson(res, 403, {
          error: "Commands are read-only",
          hint: "Set ALLOW_COMMANDS_WRITE=true to enable command edits",
        });
      }

      try {
        const body = await readBodyJson(req);
        if (!body.commands || !Array.isArray(body.commands)) {
          return sendJson(res, 400, { error: "Invalid commands format" });
        }
        
        // Validate each command
        for (const cmd of body.commands) {
          if (!cmd.id || !cmd.type || !cmd.label) {
            return sendJson(res, 400, { error: "Missing required fields" });
          }
          if (!["navigate", "terminal", "exec"].includes(cmd.type)) {
            return sendJson(res, 400, { error: "Invalid command type" });
          }
          if (cmd.type === "navigate" && !cmd.path) {
            return sendJson(res, 400, { error: "Navigate command requires path" });
          }
          if ((cmd.type === "terminal" || cmd.type === "exec") && !cmd.command) {
            return sendJson(res, 400, { error: "Command requires command" });
          }
        }

        const content = JSON.stringify(body, null, 2);
        fs.mkdirSync(path.dirname(COMMANDS_FILE), { recursive: true, mode: 0o700 });
        fs.writeFileSync(COMMANDS_FILE, content, "utf8");
        return sendJson(res, 200, { ok: true });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    if (req.method === "POST" && url.pathname === "/api/commands/reset") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });
      if (!ALLOW_COMMANDS_WRITE) {
        return sendJson(res, 403, {
          error: "Commands are read-only",
          hint: "Set ALLOW_COMMANDS_WRITE=true to enable command edits",
        });
      }

      try {
        fs.rmSync(COMMANDS_FILE, { force: true });
        return sendJson(res, 200, { ok: true, commands: readCommandsConfig() });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // Serve static miniapp files
    if (req.method === "GET" && url.pathname.startsWith("/miniapp/")) {
      const relPath = url.pathname.replace("/miniapp/", "");
      const safePath = path.normalize(relPath).replace(/^\.\.(\/|\\|$)/, "");
      const filePath = path.join(MINIAPP_DIR, safePath);
      return serveFile(res, filePath);
    }

    // Auth endpoint
    if (req.method === "POST" && url.pathname === "/auth") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!rateLimit(`auth:${ip}`, RATE_LIMIT_AUTH_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }
      const body = await readBodyJson(req);
      const initData = body.initData;
      
      // Debug log
      console.log('[tg-canvas] Auth request from', ip);
      console.log('[tg-canvas] initData present:', !!initData);
      console.log('[tg-canvas] initData length:', initData?.length || 0);
      
      if (!initData) return sendJson(res, 400, { error: "Missing initData" });

      const result = verifyTelegramInitData(initData);
      console.log('[tg-canvas] verifyTelegramInitData result:', result);
      
      if (!result.ok) return sendJson(res, 401, { error: result.error });

      const now = Math.floor(Date.now() / 1000);
      const exp = now + JWT_TTL_SECONDS;
      const token = signJwt({ userId: String(result.user.id), iat: now, exp, jti: crypto.randomUUID() });
      return sendJson(res, 200, {
        token,
        user: { id: result.user.id, username: result.user.username || null },
      });
    }

    // State endpoint
    if (req.method === "GET" && url.pathname === "/state") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!rateLimit(`state:${ip}`, RATE_LIMIT_STATE_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });
      if (currentState) {
        return sendJson(res, 200, { content: currentState.content, format: currentState.format });
      }
      return sendJson(res, 200, { content: null });
    }

    // Health endpoint
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        version: APP_VERSION,
        uptime: process.uptime(),
        clients: wsClients.size,
        hasState: !!currentState,
      });
    }

    // System stats endpoint (safe alternative to reading /proc via /fs/*)
    if (req.method === "GET" && url.pathname === "/system/stats") {
      const ip = req.socket.remoteAddress || "unknown";
      if (!rateLimit(`stats:${ip}`, RATE_LIMIT_STATE_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }

      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const loadavgText = readProcText("/proc/loadavg");
      const meminfoText = readProcText("/proc/meminfo");

      let cpu = 0;
      if (loadavgText) {
        const parts = loadavgText.trim().split(/\s+/);
        const one = parseFloat(parts[0] || "0");
        const five = parseFloat(parts[1] || "0");
        const fifteen = parseFloat(parts[2] || "0");
        const cores = Math.max(1, (os.cpus() || []).length || 1);
        const normalized = ((one + five + fifteen) / 3) / cores;
        cpu = Math.max(0, Math.min(100, Math.round(normalized * 100)));
      }

      let memory = 0;
      if (meminfoText) {
        const lines = meminfoText.split("\n");
        const totalLine = lines.find((l) => l.startsWith("MemTotal:")) || "";
        const availLine = lines.find((l) => l.startsWith("MemAvailable:")) || "";
        const totalKb = parseInt(totalLine.split(/\s+/)[1] || "0", 10);
        const availKb = parseInt(availLine.split(/\s+/)[1] || "0", 10);
        if (totalKb > 0) memory = Math.max(0, Math.min(100, Math.round(((totalKb - availKb) / totalKb) * 100)));
      }

      let disk = 0;
      try {
        const workspaceRoot = WORKSPACE_ROOT;
        const stat = fs.statfsSync(workspaceRoot);
        const total = Number(stat.blocks || 0) * Number(stat.bsize || 0);
        const free = Number(stat.bavail || 0) * Number(stat.bsize || 0);
        if (total > 0) {
          disk = Math.max(0, Math.min(100, Math.round(((total - free) / total) * 100)));
        }
      } catch (_) {
        disk = 0;
      }

      return sendJson(res, 200, { cpu, memory, disk });
    }

    // Push endpoint — PUSH_TOKEN required (loopback check retained as an additional layer
    // but is NOT sufficient alone when cloudflared is in use; see startup validation above)
    if (req.method === "POST" && url.pathname === "/push") {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return sendJson(res, 403, { error: "Forbidden" });
      }
      const headerToken = req.headers["x-push-token"] || "";
      const auth = req.headers["authorization"] || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const queryToken = url.searchParams.get("token") || "";
      const provided = headerToken || bearer || queryToken;
      if (!provided || provided !== PUSH_TOKEN) {
        return sendJson(res, 401, { error: "Invalid push token" });
      }

      const ip = req.socket.remoteAddress || 'unknown';
      if (!rateLimit(`auth:${ip}`, RATE_LIMIT_AUTH_PER_MIN, 60_000)) {
        return sendJson(res, 429, { error: "Rate limit" });
      }
      const body = await readBodyJson(req);

      let content = body.content;
      let format = body.format || null;

      if (!format) {
        if (typeof body.html !== "undefined") {
          format = "html";
          content = body.html;
        } else if (typeof body.markdown !== "undefined") {
          format = "markdown";
          content = body.markdown;
        } else if (typeof body.text !== "undefined") {
          format = "text";
          content = body.text;
        } else if (typeof body.a2ui !== "undefined") {
          format = "a2ui";
          content = body.a2ui;
        }
      }

      if (!format) format = "html";
      if (typeof content === "undefined" || content === null) {
        return sendJson(res, 400, { error: "Missing content" });
      }

      currentState = { content, format };
      const clients = broadcast({ type: "canvas", content, format });
      return sendJson(res, 200, { ok: true, clients });
    }

    // Clear endpoint — PUSH_TOKEN required (same rationale as /push)
    if (req.method === "POST" && url.pathname === "/clear") {
      if (!isLoopbackAddress(req.socket.remoteAddress)) {
        return sendJson(res, 403, { error: "Forbidden" });
      }
      const headerToken = req.headers["x-push-token"] || "";
      const auth = req.headers["authorization"] || "";
      const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
      const queryToken = url.searchParams.get("token") || "";
      const provided = headerToken || bearer || queryToken;
      if (!provided || provided !== PUSH_TOKEN) {
        return sendJson(res, 401, { error: "Invalid push token" });
      }
      currentState = null;
      broadcast({ type: "clear" });
      return sendJson(res, 200, { ok: true });
    }

    // ---- File System API ----
    const FS_DELETE_DENY_PREFIXES = (process.env.FS_DELETE_DENY_PREFIXES ||
      ".git,agents,identity,credentials,telegram,services")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const FS_DELETE_DENY_ABSOLUTE_PATHS = [
      "/",
      "/bin",
      "/boot",
      "/dev",
      "/etc",
      "/lib",
      "/lib64",
      "/proc",
      "/root",
      "/run",
      "/sbin",
      "/sys",
      "/usr",
    ].map((p) => path.resolve(p));

    function resolveFsPath(inputPath) {
      const rawPath = String(inputPath || ".").trim();
      if (!rawPath || rawPath === ".") {
        return {
          requested: ".",
          resolved: WORKSPACE_ROOT,
          displayPath: WORKSPACE_ROOT,
          withinWorkspace: true,
        };
      }

      const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(WORKSPACE_ROOT, rawPath);
      const relativeToWorkspace = path.relative(WORKSPACE_ROOT, resolved);
      const withinWorkspace = relativeToWorkspace === "" || (!relativeToWorkspace.startsWith("..") && !path.isAbsolute(relativeToWorkspace));

      return {
        requested: rawPath,
        resolved,
        displayPath: resolved,
        withinWorkspace,
        relativeToWorkspace: withinWorkspace ? (relativeToWorkspace || ".") : null,
      };
    }

    function isProtectedDeletePath(fsPath) {
      const resolved = fsPath.resolved;
      if (resolved === WORKSPACE_ROOT) {
        return true;
      }
      if (FS_DELETE_DENY_ABSOLUTE_PATHS.some((protectedPath) => resolved === protectedPath || resolved.startsWith(`${protectedPath}${path.sep}`))) {
        return true;
      }
      if (!fsPath.withinWorkspace) return false;

      const normalizedRel = fsPath.relativeToWorkspace || ".";
      return FS_DELETE_DENY_PREFIXES.some((prefix) => {
        const p = prefix.replace(/^\.?\//, "");
        return normalizedRel === p || normalizedRel.startsWith(`${p}/`);
      });
    }

    function getParentPath(resolvedPath) {
      const normalized = path.resolve(resolvedPath);
      if (normalized === path.parse(normalized).root) return null;
      return path.dirname(normalized);
    }

    // GET /fs/tree?path=.
    if (req.method === "GET" && url.pathname === "/fs/tree") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const fsPath = resolveFsPath(url.searchParams.get("path") || ".");

      try {
        const entries = fs.readdirSync(fsPath.resolved, { withFileTypes: true });
        const items = entries
          .filter(e => e.name !== '.' && e.name !== '..')
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name);
          })
          .map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : 'file',
            path: path.join(fsPath.resolved, e.name),
          }));

        return sendJson(res, 200, {
          path: fsPath.displayPath,
          absolute: fsPath.resolved,
          parentPath: getParentPath(fsPath.resolved),
          workspaceRoot: WORKSPACE_ROOT,
          withinWorkspace: fsPath.withinWorkspace,
          items,
        });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /fs/read?path=file.js
    if (req.method === "GET" && url.pathname === "/fs/read") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const requestedPath = url.searchParams.get("path");
      if (!requestedPath) return sendJson(res, 400, { error: "Missing path" });

      const fsPath = resolveFsPath(requestedPath);

      try {
        const stats = fs.statSync(fsPath.resolved);
        if (stats.isDirectory()) {
          return sendJson(res, 400, { error: "Cannot read directory" });
        }
        if (stats.size > 1024 * 1024) {
          return sendJson(res, 413, { error: "File too large (max 1MB)" });
        }
        const content = fs.readFileSync(fsPath.resolved, "utf8");
        return sendJson(res, 200, { path: fsPath.displayPath, content, size: stats.size });
      } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 404, { error: "File not found" });
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /fs/stat?path=file.js
    if (req.method === "GET" && url.pathname === "/fs/stat") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const requestedPath = url.searchParams.get("path");
      if (!requestedPath) return sendJson(res, 400, { error: "Missing path" });

      const fsPath = resolveFsPath(requestedPath);

      try {
        const stats = fs.statSync(fsPath.resolved);
        return sendJson(res, 200, {
          path: fsPath.displayPath,
          size: stats.size,
          mtime: stats.mtime.toISOString(),
          ctime: stats.ctime.toISOString(),
          isDirectory: stats.isDirectory(),
          isFile: stats.isFile(),
        });
      } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 404, { error: "File not found" });
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /fs/write
    if (req.method === "POST" && url.pathname === "/fs/write") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const body = await readBodyJson(req);
      const requestedPath = body.path;
      const content = body.content;

      if (!requestedPath) return sendJson(res, 400, { error: "Missing path" });
      if (typeof content !== 'string') return sendJson(res, 400, { error: "Missing content" });
      if (content.length > 1024 * 1024) return sendJson(res, 413, { error: "Content too large" });

      const fsPath = resolveFsPath(requestedPath);

      try {
        // Ensure parent directory exists
        const parentDir = path.dirname(fsPath.resolved);
        fs.mkdirSync(parentDir, { recursive: true });

        fs.writeFileSync(fsPath.resolved, content, "utf8");
        return sendJson(res, 200, { ok: true, path: fsPath.displayPath, size: content.length });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /fs/mkdir
    if (req.method === "POST" && url.pathname === "/fs/mkdir") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const body = await readBodyJson(req);
      const requestedPath = body.path;

      if (!requestedPath) return sendJson(res, 400, { error: "Missing path" });

      const fsPath = resolveFsPath(requestedPath);

      try {
        fs.mkdirSync(fsPath.resolved, { recursive: true });
        return sendJson(res, 200, { ok: true, path: fsPath.displayPath });
      } catch (err) {
        return sendJson(res, 500, { error: err.message });
      }
    }

    // POST /fs/delete
    if (req.method === "POST" && url.pathname === "/fs/delete") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const body = await readBodyJson(req);
      const requestedPath = body.path;

      if (!requestedPath) return sendJson(res, 400, { error: "Missing path" });

      const fsPath = resolveFsPath(requestedPath);
      if (isProtectedDeletePath(fsPath)) {
        return sendJson(res, 403, { error: "Protected path cannot be deleted" });
      }

      try {
        const stats = fs.statSync(fsPath.resolved);
        if (stats.isDirectory()) {
          fs.rmSync(fsPath.resolved, { recursive: true });
        } else {
          fs.unlinkSync(fsPath.resolved);
        }
        return sendJson(res, 200, { ok: true, path: fsPath.displayPath });
      } catch (err) {
        if (err.code === 'ENOENT') return sendJson(res, 404, { error: "Not found" });
        return sendJson(res, 500, { error: err.message });
      }
    }

    // GET /fs/search?q=keyword&type=name|content&ext=md,json
    if (req.method === "GET" && url.pathname === "/fs/search") {
      const token = getJwtFromRequest(req, url);
      const payload = verifyJwt(token);
      if (!payload) return sendJson(res, 401, { error: "Invalid token" });

      const query = url.searchParams.get("q");
      const searchType = url.searchParams.get("type") || "name"; // name, content, all
      const extFilter = url.searchParams.get("ext"); // e.g., "md,json"
      const maxResults = parseInt(url.searchParams.get("limit") || "50", 10);

      console.log('[tg-canvas] Search request:', { query, searchType, extFilter, maxResults });

      if (!query) return sendJson(res, 400, { error: "Missing search query" });

      const results = [];
      const extensions = extFilter ? extFilter.split(",").map(e => e.trim().toLowerCase().replace(/^\./, "")) : null;

      function matchesExt(filename) {
        if (!extensions) return true;
        if (!filename.includes(".")) return false;
        const ext = filename.split(".").pop().toLowerCase();
        return extensions.includes(ext);
      }

      function searchDirectory(dirPath, relDirPath) {
        if (results.length >= maxResults) return;

        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            if (results.length >= maxResults) break;
            if (entry.name.startsWith(".")) continue; // skip hidden files

            const absPath = path.join(dirPath, entry.name);
            const relPath = path.join(relDirPath, entry.name).replace(/^\.\//, "");

            if (entry.isDirectory()) {
              if ((searchType === "name" || searchType === "all") && entry.name.toLowerCase().includes(query.toLowerCase())) {
                results.push({
                  name: entry.name,
                  path: relPath,
                  type: "dir",
                  matchType: "name",
                  matchLines: null,
                });
                if (results.length >= maxResults) break;
              }
              searchDirectory(absPath, relPath);
            } else if (entry.isFile()) {
              let match = false;
              let matchLines = null;

              // Name search
              if (searchType === "name" || searchType === "all") {
                if (matchesExt(entry.name) && entry.name.toLowerCase().includes(query.toLowerCase())) {
                  match = true;
                  console.log('[tg-canvas] Name match:', entry.name);
                }
              }

              // Content search (only for text-based files)
              if ((searchType === "content" || searchType === "all") && !match && matchesExt(entry.name)) {
                const textExts = ["md", "json", "js", "ts", "py", "sh", "bash", "yaml", "yml", "txt", "html", "css", "log"];
                const ext = entry.name.split(".").pop().toLowerCase();
                if (textExts.includes(ext)) {
                  try {
                    const stats = fs.statSync(absPath);
                    if (stats.size < 1024 * 1024) { // max 1MB
                      const content = fs.readFileSync(absPath, "utf8");
                      const lines = content.split("\n");
                      const matchedLines = [];
                      for (let i = 0; i < lines.length; i++) {
                        if (lines[i].toLowerCase().includes(query.toLowerCase())) {
                          matchedLines.push({
                            line: i + 1,
                            content: lines[i].trim().slice(0, 200),
                          });
                          if (matchedLines.length >= 10) break; // limit matched lines per file
                        }
                      }
                      if (matchedLines.length > 0) {
                        match = true;
                        matchLines = matchedLines;
                        console.log('[tg-canvas] Content match:', entry.name, 'lines:', matchedLines.length);
                      }
                    }
                  } catch (err) {
                    // skip unreadable files
                  }
                }
              }

              if (match) {
                results.push({
                  name: entry.name,
                  path: relPath,
                  type: "file",
                  matchType: matchLines ? "content" : "name",
                  matchLines: matchLines,
                });
              }
            }
          }
        } catch (err) {
          console.log('[tg-canvas] Search directory error:', dirPath, err.message);
        }
      }

      searchDirectory(WORKSPACE_ROOT, ".");

      console.log('[tg-canvas] Search results:', results.length);
      return sendJson(res, 200, {
        query,
        type: searchType,
        count: results.length,
        results,
      });
    }

    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("Request error:", err);
    sendJson(res, 500, { error: "Internal server error" });
  }
});

// ---- WebSocket server (canvas) ----
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req, payload) => {
  wsClients.add(ws);

  // Send current state on connect
  if (currentState) {
    ws.send(JSON.stringify({ type: "canvas", content: currentState.content, format: currentState.format }));
  }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg && msg.type === "pong") {
        // keepalive response
      }
    } catch (_) {
      // ignore malformed
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Auth-gated WS passthrough to ttyd under /ttyd/*
  if (url.pathname === "/ttyd" || url.pathname.startsWith("/ttyd/")) {
    const token = getJwtFromRequest(req, url);
    const payload = verifyJwt(token);
    if (!payload) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const wsHeaders = { ...req.headers };
    const targetPath = url.pathname + (url.search || "");
    const proxyReq = http.request({
      host: TTYD_PROXY_HOST,
      port: TTYD_PROXY_PORT,
      method: "GET",
      path: targetPath,
      headers: wsHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        socket.write(`${k}: ${v}\r\n`);
      }
      socket.write("\r\n");
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(socket).pipe(proxySocket);
    });

    proxyReq.on("response", (r) => {
      socket.write(`HTTP/1.1 ${r.statusCode || 502} Upstream Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });

    proxyReq.on("error", (err) => {
      console.error("[tg-canvas] ws /ttyd proxy error:", err.message);
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });

    proxyReq.end();
    return;
  }

  // Auth-gated WS passthrough to local OpenClaw under /oc/*
  if (ENABLE_OPENCLAW_PROXY && url.pathname.startsWith("/oc/")) {
    const token = getJwtFromRequest(req, url);
    const payload = verifyJwt(token);
    if (!payload) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const targetPath = url.pathname.replace(/^\/oc/, "") + (url.search || "");
    const wsHeaders = { ...req.headers };
    wsHeaders.origin = normalizedProxyOrigin();
    if (OPENCLAW_GATEWAY_TOKEN) wsHeaders.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
    const proxyReq = http.request({
      host: OPENCLAW_PROXY_HOST,
      port: OPENCLAW_PROXY_PORT,
      method: "GET",
      path: targetPath,
      headers: wsHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      // forward 101 response
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        socket.write(`${k}: ${v}\r\n`);
      }
      socket.write("\r\n");

      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);

      proxySocket.pipe(socket).pipe(proxySocket);
    });

    proxyReq.on("response", (r) => {
      // Upstream rejected WS upgrade (e.g., 401). Return a concrete status instead of generic 502.
      socket.write(`HTTP/1.1 ${r.statusCode || 502} Upstream Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });

    proxyReq.on("error", (err) => {
      console.error('[tg-canvas] ws /oc proxy error:', err.message);
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });

    proxyReq.end();
    return;
  }

  // Some control-ui bundles may open absolute websocket endpoints.
  // Proxy /ws and / (gateway default) for control sessions only (oc_jwt cookie present).
  const hasOcSession = !!parseCookies(req).oc_jwt;
  if (ENABLE_OPENCLAW_PROXY && (url.pathname === '/ws' || url.pathname === '/') && hasOcSession) {
    const token = getJwtFromRequest(req, url);
    const payload = verifyJwt(token);
    if (!payload) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const wsHeaders = { ...req.headers };
    wsHeaders.origin = normalizedProxyOrigin();
    if (OPENCLAW_GATEWAY_TOKEN) wsHeaders.authorization = `Bearer ${OPENCLAW_GATEWAY_TOKEN}`;
    const proxyReq = http.request({
      host: OPENCLAW_PROXY_HOST,
      port: OPENCLAW_PROXY_PORT,
      method: "GET",
      path: url.pathname + (url.search || ''),
      headers: wsHeaders,
    });

    proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
      socket.write("HTTP/1.1 101 Switching Protocols\r\n");
      for (const [k, v] of Object.entries(proxyRes.headers)) socket.write(`${k}: ${v}\r\n`);
      socket.write("\r\n");
      if (proxyHead && proxyHead.length) socket.write(proxyHead);
      if (head && head.length) proxySocket.write(head);
      proxySocket.pipe(socket).pipe(proxySocket);
    });

    proxyReq.on('response', (r) => {
      socket.write(`HTTP/1.1 ${r.statusCode || 502} Upstream Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    });

    proxyReq.on('error', (err) => {
      console.error('[tg-canvas] ws root proxy error:', err.message);
      socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      socket.destroy();
    });
    proxyReq.end();
    return;
  }

  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const ip = req.socket.remoteAddress || "unknown";
  if (!rateLimit(`ws:${ip}`, RATE_LIMIT_AUTH_PER_MIN, 60_000)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\n\r\n");
    socket.destroy();
    return;
  }
  const token = getJwtFromRequest(req, url);
  const payload = verifyJwt(token);
  if (!payload) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, payload);
  });
});

// Keepalive ping every 30s
setInterval(() => {
  broadcast({ type: "ping" });
}, 30_000).unref();

server.listen(PORT, () => {
  console.log(`tg-canvas server listening on :${PORT}`);
});
