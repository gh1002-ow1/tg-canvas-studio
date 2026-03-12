#!/usr/bin/env node
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const crypto = require("crypto");
const readline = require("readline/promises");
const { stdin, stdout, stderr, exit, argv, env, cwd } = require("process");
const { spawnSync } = require("child_process");

const args = argv.slice(2);
const subcmd = args[0];
const BASE_URL = env.TG_CANVAS_URL || env.CANVAS_URL || "http://127.0.0.1:3721";
const PUSH_TOKEN = env.PUSH_TOKEN || "";
const PROJECT_ROOT = path.resolve(__dirname, "..");
const INSTALL_SCRIPT = path.join(PROJECT_ROOT, "scripts", "install-systemd-instance.sh");
const BOT_SETUP_SCRIPT = path.join(PROJECT_ROOT, "scripts", "setup-bot.js");
const ETC_DIR = "/etc/tg-canvas";
const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function usage(code = 0) {
  console.log(`Usage: tg-canvas <command> [options]
Commands:
  push | clear | health | terminal
  setup | add-instance      interactive instance setup
  instances                 list configured instances

Options (push): --html | --markdown | --text | --a2ui <json|@file> | --format | --content | --url
Options (setup): --instance <name> --bot-token <token> --allowed-user-ids <ids>
                 --public-url <https://...> --exposure <local|proxy|cloudflare>
                 --cloudflared-tunnel <name> --workspace-root <path> --ttyd-workdir <path>
                 --enable-openclaw-proxy <true|false> --openclaw-proxy-host <host>
                 --openclaw-proxy-port <port> --openclaw-gateway-token <token>
                 --service-user <user> --project-root <path>
                 --auto-start <true|false> --configure-bot <true|false> --force --non-interactive
terminal: activates terminal mode in the Mini App (clear to exit)`);
  exit(code);
}

function parseFlag(flag) {
  const i = args.indexOf(flag);
  if (i < 0) return null;
  const v = args[i + 1];
  if (!v || v.startsWith("--")) return null;
  return v;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function boolFlag(flag, fallback = false) {
  const v = parseFlag(flag);
  if (v == null) return fallback;
  return ["1", "true", "yes", "y", "on"].includes(String(v).trim().toLowerCase());
}

function readMaybeFile(val, { parseJson = false } = {}) {
  let raw = val;
  if (val && val.startsWith("@")) raw = fs.readFileSync(val.slice(1), "utf8");
  return parseJson ? JSON.parse(raw) : raw;
}

async function request(method, url, body) {
  const headers = body ? { "Content-Type": "application/json" } : {};
  if (PUSH_TOKEN) headers["X-Push-Token"] = PUSH_TOKEN;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}

function runCommand(cmd, cmdArgs, opts = {}) {
  const useSudo = opts.sudo && process.getuid && process.getuid() !== 0;
  const finalCmd = useSudo ? "sudo" : cmd;
  const finalArgs = useSudo ? [cmd, ...cmdArgs] : cmdArgs;
  const result = spawnSync(finalCmd, finalArgs, {
    stdio: opts.capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    env: { ...env, ...(opts.env || {}) },
    cwd: opts.cwd || cwd(),
  });
  if (result.status !== 0) {
    const msg = opts.capture ? (result.stderr || result.stdout || "").trim() : `${finalCmd} failed`;
    throw new Error(msg || `${finalCmd} failed`);
  }
  return result;
}

function readText(filePath, { sudo = false } = {}) {
  if (!sudo || (process.getuid && process.getuid() === 0)) return fs.readFileSync(filePath, "utf8");
  return runCommand("cat", [filePath], { sudo: true, capture: true }).stdout;
}

function writeText(filePath, content, { mode = "600" } = {}) {
  const tmpPath = path.join(os.tmpdir(), `tg-canvas-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    runCommand("install", ["-D", "-m", mode, tmpPath, filePath], { sudo: true });
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
}

function listEnvFiles() {
  try {
    return fs.readdirSync(ETC_DIR)
      .filter((name) => name.endsWith(".env") && !name.startsWith("."))
      .sort()
      .map((name) => path.join(ETC_DIR, name));
  } catch (_) {
    return [];
  }
}

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

function listInstances() {
  return listEnvFiles().map((filePath) => {
    const instance = path.basename(filePath, ".env");
    const parsed = parseEnvText(readText(filePath, { sudo: true }));
    return {
      instance,
      filePath,
      port: parsed.PORT || "",
      ttydPort: parsed.TTYD_PORT || "",
      publicUrl: parsed.MINIAPP_URL || "",
      exposure: parsed.CLOUDFLARED_TUNNEL ? "cloudflare" : (parsed.MINIAPP_URL ? "proxy" : "local"),
    };
  });
}

function generateSecret() {
  return crypto.randomBytes(32).toString("hex");
}

function commandExists(bin) {
  const result = spawnSync("bash", ["-lc", `command -v ${bin} >/dev/null 2>&1`], {
    stdio: "ignore",
    cwd: cwd(),
    env,
  });
  return result.status === 0;
}

function detectOpenClawProxyPort() {
  const result = spawnSync("bash", ["-lc", "openclaw gateway status --deep 2>/dev/null || true"], {
    stdio: ["ignore", "pipe", "ignore"],
    encoding: "utf8",
    cwd: cwd(),
    env,
  });
  const text = String(result.stdout || "");
  const match = text.match(/Listening:\s+127\.0\.0\.1:(\d+)/) || text.match(/port=(\d+)/);
  return match ? match[1] : "18789";
}

async function isPortFree(port) {
  return await new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findFreePort(start, usedPorts) {
  let port = start;
  while (usedPorts.has(port) || !(await isPortFree(port))) {
    port += 1;
  }
  usedPorts.add(port);
  return port;
}

function nextInstanceName(explicitName = "") {
  if (explicitName) return explicitName;
  const existing = new Set(listInstances().map((item) => item.instance));
  if (!existing.has("main")) return "main";
  let i = 2;
  while (existing.has(`bot${i}`)) i += 1;
  return `bot${i}`;
}

function defaultServiceUser() {
  return env.SUDO_USER || env.USER || "root";
}

function userHome(username) {
  const result = runCommand("getent", ["passwd", username], { capture: true });
  const line = String(result.stdout || "").trim();
  const parts = line.split(":");
  return parts[5] || os.homedir();
}

function normalizeUrl(urlValue) {
  if (!urlValue) return "";
  return String(urlValue).trim().replace(/\/+$/, "");
}

async function askQuestion(rl, label, fallback = "", { required = false } = {}) {
  while (true) {
    const suffix = fallback ? ` [${fallback}]` : "";
    const answer = (await rl.question(`${label}${suffix}: `)).trim();
    const value = answer || fallback;
    if (!required || value) return value;
  }
}

async function askChoice(rl, label, choices, fallback) {
  const rendered = choices.map((choice) => {
    if (choice === fallback) return `${choice}*`;
    return choice;
  }).join("/");
  while (true) {
    const answer = (await rl.question(`${label} (${rendered}): `)).trim().toLowerCase();
    const value = answer || fallback;
    if (choices.includes(value)) return value;
  }
}

function formatEnv(config) {
  return [
    "# Generated by tg-canvas setup",
    "",
    "# --- Telegram Auth ---",
    `BOT_TOKEN=${config.BOT_TOKEN}`,
    `ALLOWED_USER_IDS=${config.ALLOWED_USER_IDS}`,
    `JWT_SECRET=${config.JWT_SECRET}`,
    "JWT_TTL_SECONDS=900",
    "INIT_DATA_MAX_AGE_SECONDS=300",
    "",
    "# --- Canvas Server ---",
    `PORT=${config.PORT}`,
    `TG_CANVAS_URL=${config.TG_CANVAS_URL}`,
    `WORKSPACE_ROOT=${config.WORKSPACE_ROOT}`,
    `PUSH_TOKEN=${config.PUSH_TOKEN}`,
    `MINIAPP_URL=${config.MINIAPP_URL}`,
    "",
    "# --- Quick Commands ---",
    "ALLOW_COMMANDS_WRITE=true",
    "COMMAND_EXECUTION_MODE=editable",
    "COMMAND_RUN_ALLOWLIST=git-status,git-log,openclaw-status,server-logs,check-services",
    "",
    "# --- ttyd ---",
    `TTYD_PORT=${config.TTYD_PORT}`,
    `TTYD_PROXY_PORT=${config.TTYD_PROXY_PORT}`,
    `TTYD_WORKDIR=${config.TTYD_WORKDIR}`,
    "",
    "# --- Cloudflared ---",
    `CLOUDFLARED_TUNNEL=${config.CLOUDFLARED_TUNNEL}`,
    "",
    "# --- OpenClaw Proxy (optional) ---",
    `ENABLE_OPENCLAW_PROXY=${String(config.ENABLE_OPENCLAW_PROXY)}`,
    `OPENCLAW_GATEWAY_TOKEN=${config.OPENCLAW_GATEWAY_TOKEN}`,
    `OPENCLAW_PROXY_HOST=${config.OPENCLAW_PROXY_HOST}`,
    `OPENCLAW_PROXY_PORT=${config.OPENCLAW_PROXY_PORT}`,
    "",
    "# --- PATH for command execution ---",
    `PATH=${DEFAULT_PATH}`,
    "",
  ].join("\n");
}

function printSummary(config, startedServices) {
  console.log("");
  console.log(`Instance: ${config.instance}`);
  console.log(`Config: ${config.envPath}`);
  console.log(`Canvas: ${config.TG_CANVAS_URL}`);
  console.log(`Public URL: ${config.MINIAPP_URL || "(not configured)"}`);
  console.log(`Ports: app=${config.PORT}, ttyd=${config.TTYD_PORT}`);
  console.log(`Exposure: ${config.exposure}`);
  console.log(`Started: ${startedServices.join(", ") || "(none)"}`);
  console.log("");
}

async function setupInstance() {
  const nonInteractive = hasFlag("--non-interactive");
  const force = hasFlag("--force");
  const rl = nonInteractive ? null : readline.createInterface({ input: stdin, output: stdout });
  try {
    const initialInstances = listInstances();
    const explicitInstance = parseFlag("--instance") || "";
    const instance = nextInstanceName(explicitInstance);
    const serviceUser = parseFlag("--service-user") || defaultServiceUser();
    const serviceHome = userHome(serviceUser);
    const projectRoot = path.resolve(parseFlag("--project-root") || PROJECT_ROOT);
    const defaultWorkspace = env.WORKSPACE_ROOT || projectRoot;
    const defaultWorkdir = env.TTYD_WORKDIR || defaultWorkspace;
    const exposureFlag = parseFlag("--exposure");
    const exposure = rl
      ? await askChoice(rl, "Exposure mode", ["local", "proxy", "cloudflare"], exposureFlag || "local")
      : (exposureFlag || "local");
    const autoStart = boolFlag("--auto-start", true);
    const configureBot = boolFlag("--configure-bot", exposure !== "local");
    const enableOpenClawProxy = boolFlag("--enable-openclaw-proxy", false);

    const ask = async (label, fallback, opts = {}) => {
      if (rl) return askQuestion(rl, label, fallback, opts);
      const cliFlag = opts.flag ? parseFlag(opts.flag) : null;
      const value = cliFlag != null ? cliFlag : fallback;
      if (opts.required && !value) throw new Error(`Missing ${opts.flag || label}`);
      return value;
    };

    const BOT_TOKEN = await ask("Telegram bot token", parseFlag("--bot-token") || "", { required: true, flag: "--bot-token" });
    const ALLOWED_USER_IDS = await ask("Allowed Telegram user IDs (comma-separated)", parseFlag("--allowed-user-ids") || "", {
      required: true,
      flag: "--allowed-user-ids",
    });
    const publicUrlFallback = normalizeUrl(parseFlag("--public-url") || "");
    const MINIAPP_URL = exposure === "local"
      ? ""
      : normalizeUrl(await ask("Public HTTPS URL", publicUrlFallback, { required: true, flag: "--public-url" }));
    const WORKSPACE_ROOT = await ask("Workspace root", parseFlag("--workspace-root") || defaultWorkspace, {
      required: true,
      flag: "--workspace-root",
    });
    const TTYD_WORKDIR = await ask("Terminal workdir", parseFlag("--ttyd-workdir") || defaultWorkdir, {
      required: true,
      flag: "--ttyd-workdir",
    });
    const CLOUDFLARED_TUNNEL = exposure === "cloudflare"
      ? await ask("Cloudflare tunnel name", parseFlag("--cloudflared-tunnel") || "", {
          required: true,
          flag: "--cloudflared-tunnel",
        })
      : "";
    const OPENCLAW_PROXY_HOST = parseFlag("--openclaw-proxy-host") || "127.0.0.1";
    const OPENCLAW_PROXY_PORT = parseFlag("--openclaw-proxy-port") || detectOpenClawProxyPort();
    const OPENCLAW_GATEWAY_TOKEN = enableOpenClawProxy
      ? await ask("OpenClaw gateway token (optional)", parseFlag("--openclaw-gateway-token") || "", {
          required: false,
          flag: "--openclaw-gateway-token",
        })
      : "";

    const usedAppPorts = new Set(initialInstances.map((item) => Number(item.port)).filter(Boolean));
    const usedTtydPorts = new Set(initialInstances.map((item) => Number(item.ttydPort)).filter(Boolean));
    const PORT = await findFreePort(3721, usedAppPorts);
    const TTYD_PORT = await findFreePort(7681, usedTtydPorts);
    const config = {
      instance,
      envPath: path.join(ETC_DIR, `${instance}.env`),
      exposure,
      BOT_TOKEN,
      ALLOWED_USER_IDS,
      JWT_SECRET: generateSecret(),
      PUSH_TOKEN: generateSecret(),
      MINIAPP_URL,
      TG_CANVAS_URL: MINIAPP_URL || `http://127.0.0.1:${PORT}`,
      PORT,
      TTYD_PORT,
      TTYD_PROXY_PORT: TTYD_PORT,
      WORKSPACE_ROOT,
      TTYD_WORKDIR,
      CLOUDFLARED_TUNNEL,
      ENABLE_OPENCLAW_PROXY: enableOpenClawProxy,
      OPENCLAW_PROXY_HOST,
      OPENCLAW_PROXY_PORT,
      OPENCLAW_GATEWAY_TOKEN,
    };

    if (!force && fs.existsSync(config.envPath)) {
      throw new Error(`Instance already exists: ${config.instance} (${config.envPath})`);
    }

    if (autoStart && !commandExists("ttyd")) {
      throw new Error("ttyd is not installed or not on PATH; install ttyd before enabling terminal access");
    }
    if (autoStart && exposure === "cloudflare" && !commandExists("cloudflared")) {
      throw new Error("cloudflared is not installed or not on PATH");
    }

    runCommand("bash", [INSTALL_SCRIPT, "--user", serviceUser, "--root", projectRoot, "--quiet"], { cwd: projectRoot });
    runCommand("mkdir", ["-p", ETC_DIR], { sudo: true });
    writeText(config.envPath, formatEnv(config));

    const startedServices = [];
    if (autoStart) {
      const services = [
        `tg-canvas@${instance}.service`,
        `ttyd-canvas@${instance}.service`,
      ];
      if (exposure === "cloudflare") services.push(`cloudflared-canvas@${instance}.service`);
      runCommand("systemctl", ["enable", "--now", ...services], { sudo: true });
      startedServices.push(...services);
    }

    if (configureBot && MINIAPP_URL) {
      runCommand("node", [BOT_SETUP_SCRIPT], {
        env: {
          BOT_TOKEN,
          MINIAPP_URL,
        },
        cwd: projectRoot,
      });
    }

    printSummary(config, startedServices);
    return;
  } finally {
    if (rl) rl.close();
  }
}

function printInstances() {
  const items = listInstances();
  if (!items.length) {
    console.log("No configured instances.");
    return;
  }
  for (const item of items) {
    console.log(`${item.instance}\tapp:${item.port || "-"}\tttyd:${item.ttydPort || "-"}\t${item.exposure}\t${item.publicUrl || "-"}`);
  }
}

async function main() {
  if (!subcmd) usage(1);
  const base = parseFlag("--url") || BASE_URL;
  if (subcmd === "health") return console.log(JSON.stringify(await request("GET", `${base}/health`), null, 2));
  if (subcmd === "clear") return console.log(JSON.stringify(await request("POST", `${base}/clear`, { ok: true }), null, 2));
  if (subcmd === "terminal") return console.log(JSON.stringify(await request("POST", `${base}/push`, { format: "terminal", content: "" }), null, 2));
  if (subcmd === "instances") return printInstances();
  if (subcmd === "setup" || subcmd === "add-instance") return setupInstance();
  if (subcmd !== "push") return usage(1);

  const html = parseFlag("--html");
  const markdown = parseFlag("--markdown");
  const text = parseFlag("--text");
  const a2ui = parseFlag("--a2ui");
  const format = parseFlag("--format");
  const content = parseFlag("--content");
  let body = null;
  if (format && content) body = { format, content: format === "a2ui" ? readMaybeFile(content, { parseJson: true }) : readMaybeFile(content) };
  else if (html) body = { html };
  else if (markdown) body = { markdown };
  else if (text) body = { text };
  else if (a2ui) body = { a2ui: readMaybeFile(a2ui, { parseJson: true }) };
  else usage(1);

  console.log(JSON.stringify(await request("POST", `${base}/push`, body), null, 2));
}

main().catch((err) => {
  stderr.write(`${err.message || String(err)}\n`);
  exit(1);
});
