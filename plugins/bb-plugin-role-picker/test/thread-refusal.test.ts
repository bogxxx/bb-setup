import { describe, expect, test } from "bun:test";
import plugin, { reviewChain } from "../server";
import { blockKey, isAccountFailureText } from "../lib/quota-block";

// The text a Copilot reviewer's thread.start refusal carries (thr_vpvx7acjn9).
const REFUSAL =
  '403 "unauthorized: not authorized to use this Copilot feature\\n": {"category":"permission_denied","status":403}';

describe("isAccountFailureText", () => {
  test("a Copilot 403 permission_denied refusal is an account failure", () => {
    expect(isAccountFailureText(REFUSAL)).toBe(true);
  });

  test("a rate limit or an empty text is not", () => {
    expect(isAccountFailureText("429 rate limit exceeded")).toBe(false);
    expect(isAccountFailureText("")).toBe(false);
  });
});

// Any call the plugin makes at setup that these tests do not care about returns a stub.
function stub(): any {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_target, prop) => (prop === "then" ? undefined : stub()),
    apply: () => stub(),
  });
}

function fakeBb(eventRows: unknown[]) {
  const handlers = new Map<string, (payload: any) => Promise<void>>();
  const kv = new Map<string, unknown>();
  const spawned: any[] = [];
  const archived: string[] = [];
  const sent: any[] = [];
  const sdk = {
    threads: {
      events: { list: async () => eventRows },
      archive: async ({ threadId }: { threadId: string }) => {
        archived.push(threadId);
        return {};
      },
      spawn: async (input: any) => {
        spawned.push(input);
        return { id: `thr_next${spawned.length}`, status: "starting" };
      },
      send: async (input: any) => {
        sent.push(input);
        return {};
      },
    },
    environments: { get: async () => ({ hostId: "host_env" }) },
    projects: { get: async () => ({ sources: [{ hostId: "host_default", isDefault: true }] }) },
    system: { usageLimits: async () => ({}) },
  };
  const named: Record<string, unknown> = {
    sdk,
    storage: { kv: { get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => void kv.set(k, v), delete: async (k: string) => void kv.delete(k) } },
    events: { on: (name: string, handler: (payload: any) => Promise<void>) => void handlers.set(name, handler) },
  };
  const bb = new Proxy(named, { get: (target, prop) => (prop in target ? target[prop as string] : prop === "then" ? undefined : stub()) }) as any;
  return { bb, handlers, kv, spawned, archived, sent };
}

describe("a reviewer refused at thread.start", () => {
  test("permission_denied blocks the provider and moves the review to the next provider", async () => {
    const env = fakeBb([{ data: { detail: REFUSAL } }]);
    await plugin(env.bb);
    const chain = reviewChain("claude-code");
    env.kv.set("review:thr_refused", {
      orchestratorId: "thr_orch",
      worker: "thr_worker",
      body: "review it",
      chain,
      index: 0,
      projectId: "proj_1",
      environmentId: null,
    });

    await env.handlers.get("thread.failed")!({ thread: { id: "thr_refused" }, error: null });

    const failed = chain[0].providerId;
    const block = env.kv.get(blockKey(failed)) as { until: number; setAt: number };
    expect(block).toBeDefined();
    expect(block.until).toBeGreaterThan(Date.now());
    expect(env.kv.has("review:thr_refused")).toBe(false);
    expect(env.archived).toEqual(["thr_refused"]);
    expect(env.spawned).toHaveLength(1);
    expect(env.spawned[0].providerId).not.toBe(failed);
    expect(env.kv.has("review:thr_next1")).toBe(true);
    expect(env.sent[0].threadId).toBe("thr_orch");
  });

  test("a thread failure that is not a refusal leaves the review where it is", async () => {
    const env = fakeBb([{ data: { detail: "connection reset" } }]);
    await plugin(env.bb);
    env.kv.set("review:thr_flaky", {
      orchestratorId: "thr_orch",
      worker: "thr_worker",
      body: "review it",
      chain: reviewChain("claude-code"),
      index: 0,
      projectId: "proj_1",
      environmentId: null,
    });

    await env.handlers.get("thread.failed")!({ thread: { id: "thr_flaky" }, error: "connection reset" });

    expect(env.kv.has("review:thr_flaky")).toBe(true);
    expect(env.spawned).toHaveLength(0);
    expect(env.archived).toHaveLength(0);
  });
});
