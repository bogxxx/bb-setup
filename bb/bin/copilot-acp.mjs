#!/usr/bin/env node
// bb's GitHub Copilot ACP launcher (macOS and Windows). bb's provider-acp
// customAgents entry runs the `copilot-acp` shim with modelCli.selectFlag
// "--model", so bb starts Copilot on the thread's model instead of switching
// models in the session. A switch resets Copilot to the model's standard
// context window; launching on the model keeps the long one.
//
//   copilot-acp --list-models [--refresh]   model list for bb's picker
//   copilot-acp --model <id>                start Copilot ACP on that model
//
// Picker ids: <model>[-standard][-<effort>]. Models with a long context tier
// are listed twice: "Claude Opus 5.5 (1M)" runs --context long_context and
// "Claude Opus 5.5 (200k)" (id suffix -standard) runs --context default.
// Each is listed once per reasoning effort; bb groups those into one model
// with a reasoning picker. Probing takes several seconds, so the list is
// cached for a day.
//
// Auth: Copilot gets the token of the gh account COPILOT_GH_USER
// (default bohdan-krechko-akerbp, the account with a Copilot seat) through
// COPILOT_GITHUB_TOKEN, GH_TOKEN and GITHUB_TOKEN, so it works whichever gh
// account is active. Without that account it uses Copilot's own login.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const IS_WINDOWS = process.platform === "win32";
const GH_USER = process.env.COPILOT_GH_USER || "bohdan-krechko-akerbp";
const CACHE = join(homedir(), ".cache", "bb-copilot-acp", "models-v2.txt");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const WORDS = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };
const STANDARD = "-standard";

function findCopilot() {
  if (process.env.COPILOT_BIN) return process.env.COPILOT_BIN;
  const names = IS_WINDOWS ? ["copilot.exe"] : ["copilot"];
  const dirs = (process.env.PATH || process.env.Path || "").split(delimiter).filter(Boolean);
  if (IS_WINDOWS && process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "GitHubCopilotCLI"));
  if (!IS_WINDOWS) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) for (const name of names) if (existsSync(join(dir, name))) return join(dir, name);
  return names[0];
}

function copilotEnv() {
  const env = { ...process.env };
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]) delete env[key];
  let token = "";
  try {
    token = execFileSync("gh", ["auth", "token", "--user", GH_USER], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env, windowsHide: true }).trim();
  } catch {}
  if (token) env.COPILOT_GITHUB_TOKEN = env.GH_TOKEN = env.GITHUB_TOKEN = token;
  return env;
}

function formatTokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(2)}M`;
  return `${Math.round(n / 1000)}k`;
}

// Starts Copilot in ACP mode and lists the picker's models with the reasoning efforts each supports.
async function probeAcp(copilot, env) {
  const child = spawn(copilot, ["--acp"], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  child.on("error", (error) => { for (const settle of pending.values()) settle({ error }); pending.clear(); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id != null && !message.method && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? String(message.error))) : resolve(message.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await rpc("session/new", { cwd: tmpdir(), mcpServers: [] });
    const modelOption = session.configOptions.find((option) => option.category === "model" || option.id === "model");
    const models = [];
    for (const model of modelOption.options) {
      let efforts = [];
      try {
        const state = await rpc("session/set_config_option", { sessionId: session.sessionId, configId: modelOption.id, value: model.value });
        const thought = state?.configOptions?.find((option) => option.category === "thought_level");
        efforts = (thought?.options ?? []).map((option) => option.value).filter((value) => EFFORTS.includes(value));
      } catch {}
      models.push({ id: model.value, name: model.name || model.value, efforts });
    }
    return models;
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

// Asks Copilot's SDK server (models.list) for each model's standard and long context sizes.
async function probeTiers(copilot, env) {
  const child = spawn(copilot, ["--headless", "--no-auto-update", "--stdio"], { cwd: tmpdir(), env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  let nextId = 0;
  let buffer = Buffer.alloc(0);
  const pending = new Map();
  const frame = (message) => {
    const body = Buffer.from(JSON.stringify(message));
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
  };
  child.on("error", (error) => { for (const settle of pending.values()) settle({ error }); pending.clear(); });
  child.stdout.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: *(\d+)/i.exec(buffer.subarray(0, headerEnd).toString())?.[1]);
      if (buffer.length < headerEnd + 4 + length) return;
      let message;
      try { message = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()); } catch { message = {}; }
      buffer = buffer.subarray(headerEnd + 4 + length);
      if (message.method && message.id != null) child.stdin.write(frame({ jsonrpc: "2.0", id: message.id, result: null }));
      else if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message ?? String(message.error))) : resolve(message.result)));
      child.stdin.write(frame({ jsonrpc: "2.0", id, method, params }));
    });
  try {
    await rpc("connect", {});
    const { models } = await rpc("models.list", {});
    const tiers = new Map();
    for (const model of models) {
      const prices = model.billing?.tokenPrices;
      const long = prices?.longContext?.contextMax;
      if (long) tiers.set(model.id, { standard: prices.contextMax, long });
    }
    return tiers;
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

async function listModels() {
  const copilot = findCopilot();
  const env = copilotEnv();
  const [models, tiers] = await Promise.all([
    probeAcp(copilot, env),
    probeTiers(copilot, env).catch((error) => {
      console.error(`copilot-acp: context tiers unavailable: ${error.message}`);
      return new Map();
    }),
  ]);
  const lines = [];
  const add = (id, name, efforts) => {
    if (efforts.length === 0) lines.push(`${id} - ${name}`);
    for (const effort of efforts) lines.push(`${id}-${effort} - ${name} ${WORDS[effort]}`);
  };
  for (const model of models) {
    const tier = tiers.get(model.id);
    if (!tier) {
      add(model.id, model.name, model.efforts);
      continue;
    }
    add(model.id, `${model.name} (${formatTokens(tier.long)})`, model.efforts);
    add(`${model.id}${STANDARD}`, `${model.name} (${formatTokens(tier.standard)})`, model.efforts);
  }
  return lines.join("\n") + "\n";
}

function readCache(maxAgeMs) {
  try {
    if (Date.now() - statSync(CACHE).mtimeMs > maxAgeMs) return null;
    const text = readFileSync(CACHE, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

async function printModels(refresh) {
  let output = refresh ? null : readCache(MAX_AGE_MS);
  if (output === null) {
    try {
      output = await listModels();
      mkdirSync(dirname(CACHE), { recursive: true });
      writeFileSync(CACHE, output);
    } catch (error) {
      output = readCache(Number.POSITIVE_INFINITY);
      if (output === null) {
        console.error(`copilot-acp: ${error.message}`);
        process.exit(1);
      }
    }
  }
  process.stdout.write(output);
}

// Turns "--model <id>[-standard][-<effort>]" into Copilot's --model, --reasoning-effort and --context.
function launchArgs(argv) {
  const args = [];
  let context = process.env.COPILOT_CONTEXT_TIER || "long_context";
  let explicitContext = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--model" || arg.startsWith("--model=")) {
      let model = arg === "--model" ? (argv[++i] ?? "") : arg.slice("--model=".length);
      const effort = EFFORTS.find((token) => model.endsWith(`-${token}`));
      if (effort) model = model.slice(0, -(effort.length + 1));
      if (model.endsWith(STANDARD)) {
        model = model.slice(0, -STANDARD.length);
        context = "default";
      }
      args.push("--model", model);
      if (effort) args.push("--reasoning-effort", effort);
    } else if (arg === "--context" || arg.startsWith("--context=")) {
      explicitContext = true;
      args.push(arg);
      if (arg === "--context" && i + 1 < argv.length) args.push(argv[++i]);
    } else {
      args.push(arg);
    }
  }
  if (!explicitContext) args.push("--context", context);
  return ["--acp", ...args];
}

function launch(argv) {
  const child = spawn(findCopilot(), launchArgs(argv), { env: copilotEnv(), stdio: "inherit", windowsHide: true });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));
  child.on("error", (error) => {
    console.error(`copilot-acp: ${error.message}`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}

const argv = process.argv.slice(2);
if (argv[0] === "--list-models") await printModels(argv.includes("--refresh"));
else if (argv[0] === "--print-args") console.log(JSON.stringify(launchArgs(argv.slice(1))));
else launch(argv);
