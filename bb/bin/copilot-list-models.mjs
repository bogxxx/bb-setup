#!/usr/bin/env node
// Prints Copilot's models for bb's ACP model picker, one "id - Name" line per
// reasoning variant (for example "claude-opus-5.5-high - Claude Opus 5.5 High").
// bb groups the variants into one model with a reasoning picker, and
// copilot-acp turns "--model <id>-<effort>" back into --model/--reasoning-effort.
// Probing takes several seconds, so results are cached for a day.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const COPILOT = process.env.COPILOT_BIN || "/opt/homebrew/bin/copilot";
const CACHE = join(homedir(), ".cache", "bb-copilot-acp", "models.txt");
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const WORDS = { none: "None", low: "Low", medium: "Medium", high: "High", xhigh: "Extra High", max: "Max" };

function readCache(maxAgeMs) {
  try {
    if (Date.now() - statSync(CACHE).mtimeMs > maxAgeMs) return null;
    const text = readFileSync(CACHE, "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

async function probe() {
  const child = spawn(COPILOT, ["--acp"], { cwd: tmpdir(), stdio: ["pipe", "pipe", "ignore"] });
  let nextId = 0;
  let buffer = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.id != null && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const exited = new Promise((resolve) => child.on("exit", resolve));
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, (message) => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  try {
    await rpc("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const session = await rpc("session/new", { cwd: tmpdir(), mcpServers: [] });
    const modelOption = session.configOptions.find((option) => option.category === "model" || option.id === "model");
    const lines = [];
    for (const model of modelOption.options) {
      const name = model.name || model.value;
      let efforts = [];
      try {
        const state = await rpc("session/set_config_option", { sessionId: session.sessionId, configId: modelOption.id, value: model.value });
        const thought = state?.configOptions?.find((option) => option.category === "thought_level");
        efforts = (thought?.options ?? []).map((option) => option.value).filter((value) => EFFORTS.includes(value));
      } catch {
        efforts = [];
      }
      if (efforts.length === 0) {
        lines.push(`${model.value} - ${name}`);
        continue;
      }
      for (const effort of efforts) lines.push(`${model.value}-${effort} - ${name} ${WORDS[effort]}`);
    }
    return lines.join("\n") + "\n";
  } finally {
    child.kill();
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

let output = process.argv.includes("--refresh") ? null : readCache(MAX_AGE_MS);
if (output === null) {
  try {
    output = await probe();
    mkdirSync(join(CACHE, ".."), { recursive: true });
    writeFileSync(CACHE, output);
  } catch (error) {
    output = readCache(Number.POSITIVE_INFINITY);
    if (output === null) {
      console.error(`copilot-list-models: ${error.message}`);
      process.exit(1);
    }
  }
}
process.stdout.write(output);
