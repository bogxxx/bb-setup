import { describe, expect, test } from "bun:test";
import plugin from "../server";

// Catalog lists per provider, in the order the live catalog uses.
const OPUS = ["low", "medium", "high", "xhigh", "ultracode", "max"];

function entry(id: string, levels: string[]) {
  return { id, model: id, isDefault: false, supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort })) };
}

// Any call the plugin makes at setup that these tests do not care about returns a stub.
function stub(): any {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_target, prop) => (prop === "then" ? undefined : stub()),
    apply: () => stub(),
  });
}

type Fake = {
  level: string | null | Error;
  catalogs: Record<string, unknown[]>;
};

function fakeBb(fake: Fake) {
  const handlers = new Map<string, (payload: any) => Promise<void>>();
  const tools = new Map<string, any>();
  const kv = new Map<string, unknown>();
  const spawned: any[] = [];
  const catalogCalls: string[] = [];
  const executionCalls = { count: 0 };
  const sdk = {
    threads: {
      get: async () => ({ providerId: "claude-code", projectId: "proj_1", environmentId: null }),
      getPluginMetadata: async () => ({ role: "orchestrator" }),
      defaultExecutionOptions: async () => {
        executionCalls.count++;
        if (fake.level instanceof Error) throw fake.level;
        return fake.level === null ? null : { model: "claude-opus-5-5", permissionMode: "full", reasoningLevel: fake.level, serviceTier: "default", source: "client/thread/start" };
      },
      events: { list: async () => [] },
      archive: async () => ({}),
      spawn: async (input: any) => {
        spawned.push(input);
        return { id: `thr_next${spawned.length}`, status: "starting" };
      },
      send: async () => ({}),
    },
    environments: { get: async () => ({ hostId: "host_env" }) },
    projects: { get: async () => ({ sources: [{ hostId: "host_default", isDefault: true }] }) },
    system: {
      usageLimits: async () => ({}),
      executionOptions: async ({ providerId }: { providerId: string }) => {
        catalogCalls.push(providerId);
        return { modelLoadError: null, models: fake.catalogs[providerId] ?? [], selectedOnlyModels: [] };
      },
    },
  };
  const named: Record<string, unknown> = {
    sdk,
    agents: { registerTool: (definition: any) => void tools.set(definition.name, definition), configure: () => undefined },
    storage: {
      kv: {
        get: async (k: string) => kv.get(k),
        set: async (k: string, v: unknown) => void kv.set(k, v),
        delete: async (k: string) => void kv.delete(k),
      },
    },
    events: { on: (name: string, handler: (payload: any) => Promise<void>) => void handlers.set(name, handler) },
  };
  const bb = new Proxy(named, { get: (target, prop) => (prop in target ? target[prop as string] : prop === "then" ? undefined : stub()) }) as any;
  const spawn = (name: string, extra: Record<string, unknown> = {}) =>
    tools.get("spawn")!.execute({ name, assignment: "do the work", ...extra }, { threadId: "thr_orch" });
  return { bb, handlers, kv, spawned, catalogCalls, executionCalls, spawn };
}

describe("spawn plan follows the orchestrator's effort", () => {
  test("a plan runs at the orchestrator's level, fitted to the model", async () => {
    const env = fakeBb({ level: "xhigh", catalogs: { "claude-code": [entry("claude-opus-5-5", OPUS)] } });
    await plugin(env.bb);
    await env.spawn("plan");
    expect(env.spawned[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "xhigh" });
  });

  test("explore and contribute stay at high and never read the orchestrator's level", async () => {
    const env = fakeBb({ level: "xhigh", catalogs: { "claude-code": [entry("claude-opus-5-5", OPUS)] } });
    await plugin(env.bb);
    await env.spawn("explore");
    await env.spawn("contribute");
    expect(env.spawned.map((input) => input.reasoningLevel)).toEqual(["high", "high"]);
    expect(env.executionCalls.count).toBe(0);
  });

  test("an unreadable orchestrator level keeps the plan pin", async () => {
    const env = fakeBb({ level: new Error("no session"), catalogs: {} });
    await plugin(env.bb);
    await env.spawn("plan");
    expect(env.spawned[0]).toMatchObject({ reasoningLevel: "medium" });
  });
});

describe("spawn review follows the orchestrator's effort", () => {
  const record = (env: ReturnType<typeof fakeBb>) => env.kv.get("review:thr_next1") as any;

  test("the first reviewer gets the level, and the record keeps it for a fallback", async () => {
    const env = fakeBb({ level: "xhigh", catalogs: {} });
    await plugin(env.bb);
    await env.spawn("review", { worker: "thr_worker" });
    expect(env.spawned[0]).toMatchObject({ providerId: "acp-antigravity", model: "gemini-4-argon", reasoningLevel: "xhigh" });
    expect(record(env).orchestratorLevel).toBe("xhigh");
  });

  test("a quota fallback reuses the stored level without reading it again", async () => {
    const env = fakeBb({ level: "xhigh", catalogs: {} });
    await plugin(env.bb);
    await env.spawn("review", { worker: "thr_worker" });
    await env.handlers.get("thread.idle")!({ thread: { id: "thr_next1" }, lastAssistantText: "⚠ Individual quota reached. Resets in 1h." });
    expect(env.spawned[1]).toMatchObject({ providerId: "acp-github-copilot-cli", model: "gpt-6.1-sol-medium", reasoningLevel: "medium" });
    expect(env.executionCalls.count).toBe(1);
  });

  test("a Copilot fallback takes the listed suffixed id for the level", async () => {
    const env = fakeBb({
      level: "xhigh",
      catalogs: { "acp-github-copilot-cli": [entry("gpt-6.1-sol-medium", []), entry("gpt-6.1-sol-xhigh", [])] },
    });
    await plugin(env.bb);
    await env.spawn("review", { worker: "thr_worker" });
    await env.handlers.get("thread.idle")!({ thread: { id: "thr_next1" }, lastAssistantText: "⚠ Individual quota reached. Resets in 1h." });
    expect(env.spawned[1]).toMatchObject({ providerId: "acp-github-copilot-cli", model: "gpt-6.1-sol-xhigh", reasoningLevel: "xhigh" });
  });
});
