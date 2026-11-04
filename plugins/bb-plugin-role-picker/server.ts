import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SHIPPED_AGENTS } from "./agents.generated.js";

const roleSchema = z.enum(["regular", "orchestrator"]);
type Role = z.infer<typeof roleSchema>;

export const rpcContract = defineRpcContract({
  get_role: {
    input: z.object({ threadId: z.string().nullable() }).strict(),
    output: z.object({
      role: roleSchema,
      source: z.enum(["thread", "default"]),
      applies: z.string(),
    }),
  },
  set_role: {
    input: z.object({ threadId: z.string().nullable(), role: roleSchema }).strict(),
    output: z.object({
      role: roleSchema,
      source: z.enum(["thread", "default"]),
      applies: z.string(),
    }),
  },
});

const APPLIES =
  "A new thread uses this on its first session. An open session keeps its current instructions until BB starts that provider session again.";

function readRole(value: unknown): Role | null {
  const parsed = roleSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

type SpawnName = "explore" | "contribute" | "plan" | "review";

/** An agent file: the folder under the user's home and the file's name there. */
interface AgentRef {
  dir: ".claude" | ".cursor";
  name: string;
}

type SpawnSpec = {
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  sessionOptions?: Record<string, string>;
  agent?: AgentRef;
};

// Reviewers by id. Fallback order is per worker provider in REVIEW_ORDER.
const REVIEWERS: Record<string, SpawnSpec> = {
  gemini: { providerId: "acp-antigravity", model: "gemini-4-argon", reasoningLevel: "medium" },
  "copilot-opus": { providerId: "acp-github-copilot-cli", model: "claude-opus-5.5", reasoningLevel: "medium", sessionOptions: { agent: "reviewer" } },
  "copilot-sol": { providerId: "acp-github-copilot-cli", model: "gpt-6.1-sol", reasoningLevel: "medium", sessionOptions: { agent: "reviewer" } },
  "claude-opus": { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium" },
  codex: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" },
  // cantrip-review: its model and instructions come from the agent file.
  cursor: { providerId: "acp-cursor", agent: { dir: ".cursor", name: "cantrip-review.md" } },
};

// The reviewer chain for a worker on a provider, tried in order when one runs out of quota.
// No entry runs on the worker's provider and no two entries share a provider, except Copilot
// and Cursor: their work stays inside them and is reviewed there by another vendor's model
// (Copilot's GPT worker gets Opus; Cursor gets cantrip-review on Meta's Muse).
// A Claude worker is never reviewed by a Claude model (Opus or Haiku). Everyone else gets
// Opus 5.5 second, unless it is already first.
const REVIEW_ORDER: Record<string, string[]> = {
  "claude-code": ["gemini", "copilot-sol", "cursor"],
  "acp-github-copilot-cli": ["copilot-opus"],
  "acp-cursor": ["cursor"],
  "acp-antigravity": ["copilot-opus", "codex", "claude-opus"],
  codex: ["gemini", "claude-opus", "copilot-sol"],
};

const SAME_PROVIDER_REVIEW = new Set(["acp-github-copilot-cli", "acp-cursor"]);

function reviewChain(parentProviderId: string): string[] {
  const order = REVIEW_ORDER[parentProviderId] ?? ["gemini", "claude-opus", "codex"];
  // Copilot and Cursor review their own work on another vendor's model; everyone else leaves their provider.
  const seen = new Set<string>(SAME_PROVIDER_REVIEW.has(parentProviderId) ? [] : [parentProviderId]);
  return order.filter((id) => {
    const providerId = REVIEWERS[id]?.providerId;
    if (!providerId || seen.has(providerId)) return false;
    seen.add(providerId);
    return true;
  });
}

function spawnSpec(parentProviderId: string, name: Exclude<SpawnName, "review">): SpawnSpec {
  if (parentProviderId === "acp-cursor") {
    const agent = {
      explore: "cantrip-explore.md",
      contribute: "cantrip-implement.md",
      plan: "cantrip-plan.md",
    }[name];
    return { providerId: "acp-cursor", agent: { dir: ".cursor", name: agent } };
  }
  if (parentProviderId === "claude-code") {
    const claude = {
      explore: { model: "claude-haiku-5-5", agent: { dir: ".claude" as const, name: "explorer.md" } },
      contribute: { model: "claude-haiku-5-5", agent: { dir: ".claude" as const, name: "worker.md" } },
      plan: { model: "claude-opus-5-5", agent: { dir: ".claude" as const, name: "planner.md" } },
    }[name];
    return { providerId: "claude-code", reasoningLevel: "medium", ...claude };
  }
  if (parentProviderId === "acp-github-copilot-cli") {
    const copilot = {
      explore: { model: "claude-haiku-5.5", sessionOptions: { agent: "explorer" } },
      contribute: { model: "gpt-6.1-terra", reasoningLevel: "medium", sessionOptions: { agent: "worker" } },
      plan: { model: "claude-opus-5.5", sessionOptions: { agent: "planner" } },
    }[name];
    return { providerId: "acp-github-copilot-cli", ...copilot };
  }
  return { providerId: parentProviderId };
}

// A failure that means the provider cannot serve this review: quota, credits, spend limit, or login.
const QUOTA_CATEGORIES = new Set(["rate-limit", "billing", "budget-exceeded", "unauthorized"]);
const DEFAULT_BLOCK_MS = 60 * 60 * 1000;

type ReviewRecord = {
  orchestratorId: string;
  worker: string;
  body: string;
  chain: string[];
  index: number;
  projectId: string;
  environmentId: string | null;
};

/**
 * An agent's file, read in this order: the copy in the user's home on the machine
 * the server runs on, then the copy shipped with this plugin (generated from the
 * repo's agents). Neither: no body and a warning, so the spawn still goes ahead.
 */
function agentDefinition(
  agent: AgentRef,
  warn: (message: string) => void,
): { model?: string; reasoningLevel?: string; serviceTier?: string; body: string } {
  const local = path.join(os.homedir(), agent.dir, "agents", agent.name);
  let raw: string | null = null;
  if (existsSync(local)) {
    try {
      raw = readFileSync(local, "utf8");
    } catch {
      raw = null;
    }
  }
  raw ??= SHIPPED_AGENTS[`${agent.dir}/agents/${agent.name}`] ?? null;
  if (raw === null) {
    warn(`agent file ${agent.dir}/agents/${agent.name} is not on this machine or in the plugin; spawning without its instructions`);
    return { body: "" };
  }
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  const front = match?.[1] ?? "";
  const body = (match?.[2] ?? raw).trim();
  const modelLine = front.match(/^model:\s*"?([^"\n]+)"?\s*$/m)?.[1] ?? "";
  const id = modelLine.match(/^([^[]+)/)?.[1]?.trim();
  const reasoningLevel = modelLine.match(/(?:reasoning_effort|effort)=([a-z0-9]+)/)?.[1];
  const fast = modelLine.match(/fast=(true|false)/)?.[1];
  const model = id === "muse-wonder" ? "muse-wonder-1.0" : id;
  return {
    model,
    reasoningLevel,
    serviceTier: fast === "false" ? "default" : undefined,
    body,
  };
}

function procedure(_providerId: string, role: Role): string {
  if (role === "regular") {
    return [
      "Role: regular.",
      "Do the work in this session.",
      "Do not call spawn.",
    ].join(" ");
  }
  return [
    "You spawn only. Do not explore, plan, contribute, or review in this session.",
    "Call spawn with name explore, contribute, plan, or review. The assignment is only the task.",
    "Planning is the default: spawn plan before any contribute. Skip it only when ALL hold: the change is small (about one file or a few lines), the request is unambiguous, the approach is obvious with no design choices, and no exploration is needed to know where or what to edit. State the skip in one line. When in doubt, plan. Multi-file changes, new features, refactors, bug fixes with an unknown root cause, and cross-component behavior always get a plan. Sequence: explore (if needed), plan, contribute, review.",
    "spawn returns the thread id as soon as the thread exists. Wait with bb thread wait <id>, then read the report with bb thread output <id>, before you use it.",
    "Do not name the model and do not say which agent it is. spawn reads that from the agent file.",
    "explore may use the terminal. contribute is the only one that edits.",
    "Review loop: spawn contribute first and wait for its report. Then spawn review with worker set to the contribute thread id. The reviewer sends defects straight to that worker, which fixes them and replies, up to two rounds. Wait on the reviewer alone and read its output: CLEAN, or ESCALATE with the findings left. On ESCALATE, tell the same worker what to do next, or ask the user.",
    "Each review runs on a provider other than the worker's. If a reviewer stops on a provider quota, the plugin moves the review to the next provider and messages you the new reviewer thread id: wait on that one instead. If a reviewer ends in error and no such message comes, spawn review again with the same worker; spawn skips providers that are out of quota.",
    "Do not use the Task tool.",
  ].join(" ");
}

function reviewerProtocol(workerId: string, replaces?: string): string {
  return [
    ...(replaces
      ? ["You replace reviewer thread " + replaces + ", which stopped because its provider ran out of quota. First read bb thread output " + workerId + ". If the worker already answered a REVIEW round from " + replaces + ", review its current code and continue the round count from there."]
      : []),
    "Review loop. You review the worker's change and send defects to the worker, not to the orchestrator.",
    "The user authorized one messaging exception for this loop only: you may message your worker, thread " + workerId + ", and no other thread.",
    "Your own thread id is $BB_THREAD_ID; run bb status if it is unset. Use it only to name yourself in messages.",
    "Review the worker's diff against the assignment. Read files and run read-only git or diff commands only. Do not edit files.",
    "If you find no defects, end your turn with a final report that starts with CLEAN.",
    "If you find defects, send them to the worker in one message: bb thread tell " + workerId + " --mode auto --message-file -, with a quoted heredoc. The first line is `REVIEW round N/2 from thread:<your thread id>`, where N is 1 or 2. Then list each finding in severity order with path:line, the failure scenario, and the required correction.",
    "Then run bb thread wait " + workerId + ", and read bb thread output " + workerId + ". Go on only when it starts with FIXED round N or BLOCKED for the round you sent. If it does not, wait again, at most two more times. If the worker is idle and still has no FIXED or BLOCKED reply for your round, treat the round as BLOCKED. Then review the changed code again.",
    "Send at most two REVIEW rounds. If findings remain after the second fix, or the worker replies BLOCKED, end your turn with a final report that starts with ESCALATE and lists the findings left.",
    "Send no other messages, acknowledgements, or thanks. Do not bb thread tell the orchestrator, even when bb status shows Parent notifications: stuck. Your final report is read by the orchestrator with bb thread output.",
  ].join("\n");
}

function workerProtocol(): string {
  return [
    "Review loop. A reviewer may send you a message that starts with `REVIEW round N/2 from thread:<id>`. Only that message starts a fix round.",
    "The user authorized one messaging exception for this loop only: reply to that reviewer thread, and to no other thread.",
    "For a REVIEW round, fix only the findings in that message and keep to your original scope. Run the verification commands from your original assignment. If a finding is wrong, change no code for it; say why, with evidence.",
    "Then reply with bb thread tell <reviewer id> --mode auto --message-file -, using a quoted heredoc. Start the reply with `FIXED round N`, then each finding and what you changed, then the check commands with exit codes and the tail of their output. If you cannot fix a finding, start the reply with `BLOCKED` and the reason. Put the same text in your final response.",
    "Do not decide that the task is complete, do not review the diff, and send no acknowledgements or thanks.",
    "Your final response is read by the orchestrator with bb thread output. Do not bb thread tell the orchestrator, even when bb status shows Parent notifications: stuck.",
  ].join("\n");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    defaultRole: {
      type: "select",
      label: "Default role for a new thread",
      options: ["regular", "orchestrator"],
      experimental_optionLabels: {
        regular: "Regular",
        orchestrator: "Orchestrator",
      },
      default: "regular",
    },
  });

  async function roleForThread(threadId: string): Promise<{ role: Role; source: "thread" | "default" }> {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId });
    const saved = readRole(metadata.role);
    if (saved) return { role: saved, source: "thread" };
    const { defaultRole } = await settings.get();
    return { role: readRole(defaultRole) ?? "regular", source: "default" };
  }

  bb.rpc.register(rpcContract, {
    async get_role({ threadId }) {
      if (!threadId) {
        const { defaultRole } = await settings.get();
        return { role: readRole(defaultRole) ?? "regular", source: "default" as const, applies: APPLIES };
      }
      const found = await roleForThread(threadId);
      return { ...found, applies: APPLIES };
    },
    async set_role({ threadId, role }) {
      if (!threadId) {
        await settings.experimental_set({ defaultRole: role });
        return { role, source: "default" as const, applies: APPLIES };
      }
      await bb.sdk.threads.updatePluginMetadata({ threadId, set: { role } });
      return { role, source: "thread" as const, applies: APPLIES };
    },
  });

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: ctx.thread.id });
    if (readRole(metadata.role)) return { action: "proceed" };
    const { defaultRole } = await settings.get();
    await bb.sdk.threads.updatePluginMetadata({
      threadId: ctx.thread.id,
      set: { role: readRole(defaultRole) ?? "regular" },
    });
    return { action: "proceed" };
  });

  const spawnName = z.enum(["explore", "contribute", "plan", "review"]);

  bb.agents.registerTool({
    name: "spawn",
    description:
      "Spawn one of the four agents: explore, contribute, plan, or review. Plan before any contribute unless the change is small and obvious. Returns the thread id immediately. A review takes the contribute thread id as worker and sends its defects straight to that worker. The orchestrator does no other work.",
    instructions:
      "Orchestrators call spawn only. The only names are explore, contribute, plan, and review. contribute is the worker. Planning is the default: spawn plan before contribute, and skip it only when the change is small, unambiguous, obvious, and needs no exploration (state the skip in one line). spawn returns the thread id immediately. Review loop: spawn contribute and wait for its report; then spawn review with worker set to the contribute thread id. The reviewer sends defects to that worker and reports to you only at the end: CLEAN, or ESCALATE. Wait on the reviewer, then read bb thread output <id>, before using the report.",
    presentation: {
      label: { pending: "Spawning agent", completed: "Spawned agent" },
    },
    parameters: z.object({
      name: spawnName,
      assignment: z.string().min(1),
      worker: z.string().min(1).optional().describe("Required for review: the contribute thread id whose diff is reviewed. Not used by the other names."),
    }).strict(),
    async execute({ name, assignment, worker: workerParam }, ctx) {
      const parent = await bb.sdk.threads.get({ threadId: ctx.threadId });
      const mode = await roleForThread(ctx.threadId);
      if (mode.role !== "orchestrator") {
        return { isError: true, content: [{ type: "text" as const, text: "spawn is only for the orchestrator role." }] };
      }
      const fail = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });
      const clean = (id: string) => id.trim().replace(/^@thread:/, "");
      // Fallback for sessions whose published schema predates the worker parameter: accept a
      // first assignment line `worker: thr_xxx`. The line is removed from the assignment.
      const firstLine = name === "review" ? assignment.match(/^worker:[ \t]*(\S+)[ \t]*(?:\r?\n|$)/) : null;
      if (workerParam && firstLine && clean(firstLine[1]) !== clean(workerParam)) {
        return fail("spawn review got two different worker ids: the worker parameter and the worker: line.");
      }
      const worker = clean(workerParam ?? firstLine?.[1] ?? "");
      const body = (firstLine ? assignment.slice(firstLine[0].length) : assignment).trim();
      if (!body) return fail("spawn needs an assignment after any worker: line.");
      if (name !== "review" && worker) return fail("worker is only for spawn review.");
      if (name === "review") {
        if (!worker) return fail("spawn review needs worker: the contribute thread id whose diff is reviewed.");
        if (!/^thr_[a-z0-9]+$/i.test(worker)) return fail(`spawn review worker must be a thread id like thr_xxx, got "${worker}".`);
        if (worker === ctx.threadId) return fail("spawn review worker must not be the orchestrator's own thread.");
        const exists = await bb.sdk.threads.get({ threadId: worker }).then(() => true, () => false);
        if (!exists) return fail(`spawn review worker ${worker} was not found.`);
      }
      if (name === "review") {
        const record: ReviewRecord = {
          orchestratorId: ctx.threadId,
          worker,
          body,
          chain: reviewChain(parent.providerId),
          index: 0,
          projectId: parent.projectId,
          environmentId: parent.environmentId ?? null,
        };
        const spawned = await spawnReviewer(record);
        if (!spawned) {
          return fail(`No reviewer is available: every review provider for a ${parent.providerId} worker (${record.chain.map((id) => REVIEWERS[id].providerId).join(", ")}) is out of quota or unavailable. Ask the user.`);
        }
        return {
          content: [{
            type: "text" as const,
            text: [
              `Spawned review as ${spawned.id} on ${spawned.providerId}. Status: ${spawned.status}.`,
              "spawn returns when the thread exists. It does not wait for the agent.",
              "If this reviewer stops on a provider quota, you get a message with the replacement reviewer id; wait on that one instead.",
              "Wait, then read the report, before you use it:",
              `bb thread wait ${spawned.id}`,
              `bb thread output ${spawned.id}`,
            ].join("\n"),
          }],
        };
      }
      const spec = spawnSpec(parent.providerId, name);
      const defined = spec.agent ? agentDefinition(spec.agent, (message) => bb.log.warn(message)) : undefined;
      const protocol = name === "contribute" ? workerProtocol() : "";
      const prompt = [
        defined?.body,
        "Assignment:\n" + body,
        protocol,
      ].filter((part): part is string => Boolean(part)).join("\n\n");

      const child = await bb.sdk.threads.spawn({
        projectId: parent.projectId,
        providerId: spec.providerId,
        parentThreadId: ctx.threadId,
        parentNotifications: name === "contribute" ? "stuck" : "auto",
        permissionMode: "full",
        title: name,
        ...(parent.environmentId
          ? { environment: { type: "reuse" as const, environmentId: parent.environmentId } }
          : { environment: { type: "project-default" as const } }),
        ...((defined?.model ?? spec.model) ? { model: defined?.model ?? spec.model } : {}),
        ...((defined?.reasoningLevel ?? spec.reasoningLevel) ? { reasoningLevel: defined?.reasoningLevel ?? spec.reasoningLevel } : {}),
        ...(defined?.serviceTier ? { serviceTier: defined.serviceTier } : {}),
        ...(spec.sessionOptions ? { sessionOptions: spec.sessionOptions } : {}),
        pluginMetadata: { role: "regular" },
        prompt,
      });

      return {
        content: [{
          type: "text" as const,
          text: [
            `Spawned ${name} as ${child.id}. Status: ${child.status}.`,
            "spawn returns when the thread exists. It does not wait for the agent.",
            "Wait, then read the report, before you use it:",
            `bb thread wait ${child.id}`,
            `bb thread output ${child.id}`,
          ].join("\n"),
        }],
      };
    },
  });

  // Quota tracking. A provider that failed a reviewer on quota is skipped until its window resets.
  const kv = bb.storage.kv;
  const blockKey = (providerId: string) => `quota-blocked:${providerId}`;
  const reviewKey = (threadId: string) => `review:${threadId}`;

  async function providerAvailable(providerId: string): Promise<boolean> {
    const until = await kv.get<number>(blockKey(providerId));
    if (typeof until === "number") {
      if (until > Date.now()) return false;
      await kv.delete(blockKey(providerId));
    }
    // Best effort: a provider whose usage report shows a used-up window, or no usable login, is skipped.
    try {
      const usage = await Promise.race([
        bb.sdk.system.usageLimits({ providerId }),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      const entry = usage?.[providerId];
      if (!entry) return true;
      if (entry.status === "not_installed" || entry.status === "unauthenticated" || entry.status === "expired") return false;
      if (entry.status === "ok" && entry.windows.some((w) => w.usedPercent >= 100)) return false;
    } catch {
      // No usage report for this provider; assume it is available.
    }
    return true;
  }

  async function spawnReviewer(
    record: ReviewRecord,
    replaces?: string,
  ): Promise<{ id: string; status: string; providerId: string } | null> {
    for (let index = record.index; index < record.chain.length; index++) {
      const spec = REVIEWERS[record.chain[index]];
      const providerId = spec.providerId;
      if (!(await providerAvailable(providerId))) continue;
      const defined = spec.agent ? agentDefinition(spec.agent, (message) => bb.log.warn(message)) : undefined;
      const model = defined?.model ?? spec.model;
      const reasoningLevel = defined?.reasoningLevel ?? spec.reasoningLevel;
      const prompt = [defined?.body, "Assignment:\n" + record.body, reviewerProtocol(record.worker, replaces)]
        .filter((part): part is string => Boolean(part))
        .join("\n\n");
      try {
        const child = await bb.sdk.threads.spawn({
          projectId: record.projectId,
          providerId: spec.providerId,
          parentThreadId: record.orchestratorId,
          parentNotifications: "stuck",
          permissionMode: "full",
          title: "review",
          ...(record.environmentId
            ? { environment: { type: "reuse" as const, environmentId: record.environmentId } }
            : { environment: { type: "project-default" as const } }),
          ...(model ? { model } : {}),
          ...(reasoningLevel ? { reasoningLevel } : {}),
          ...(defined?.serviceTier ? { serviceTier: defined.serviceTier } : {}),
          ...(spec.sessionOptions ? { sessionOptions: spec.sessionOptions } : {}),
          pluginMetadata: { role: "regular" },
          prompt,
        });
        await kv.set(reviewKey(child.id), { ...record, index } satisfies ReviewRecord);
        return { id: child.id, status: child.status, providerId };
      } catch (error) {
        bb.log.warn(`review spawn on ${providerId} failed: ${String(error)}`);
      }
    }
    return null;
  }

  bb.events.on("turn.failed", async (event) => {
    const record = await kv.get<ReviewRecord>(reviewKey(event.threadId));
    if (!record) return;
    const category = event.errorInfo?.category;
    const quota = (category && QUOTA_CATEGORIES.has(category)) || event.rateLimits?.status === "blocked";
    if (!quota) return;
    await kv.delete(reviewKey(event.threadId));

    const failedProvider = REVIEWERS[record.chain[record.index]].providerId;
    const resets = (event.rateLimits?.windows ?? [])
      .filter((w) => w.status === "blocked" && typeof w.resetsAtMs === "number")
      .map((w) => w.resetsAtMs as number);
    const until = resets.length ? Math.max(...resets) : Date.now() + DEFAULT_BLOCK_MS;
    await kv.set(blockKey(failedProvider), until);

    // Stop the failed reviewer so a core retry after the window resets does not run a second review.
    await bb.sdk.threads.archive({ threadId: event.threadId }).catch(() => undefined);

    const next = await spawnReviewer({ ...record, index: record.index + 1 }, event.threadId);
    const text = next
      ? [
          `Reviewer ${event.threadId} on ${failedProvider} stopped: provider quota reached (${category ?? "rate limit"}).`,
          `The review moved to ${next.id} on ${next.providerId}, for worker ${record.worker}.`,
          `Wait on the new reviewer: bb thread wait ${next.id}, then bb thread output ${next.id}.`,
        ].join("\n")
      : [
          `Reviewer ${event.threadId} on ${failedProvider} stopped: provider quota reached (${category ?? "rate limit"}).`,
          `No other review provider is available for worker ${record.worker} (tried ${record.chain.map((id) => REVIEWERS[id].providerId).join(", ")}). Ask the user how to proceed.`,
        ].join("\n");
    await bb.sdk.threads
      .send({ threadId: record.orchestratorId, mode: "auto", input: [{ type: "text", text, mentions: [] }] })
      .catch((error) => bb.log.warn(`could not tell orchestrator ${record.orchestratorId}: ${String(error)}`));
  });

  bb.agents.registerTool({
    name: "role_choice",
    description: "Read the role selected in the composer Role control for this thread.",
    instructions: "Call role_choice before development work and follow the role it returns.",
    presentation: {
      label: { pending: "Reading role", completed: "Read role" },
    },
    parameters: z.object({}).strict(),
    async execute(_input, ctx) {
      const found = await roleForThread(ctx.threadId);
      const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
      return {
        content: [
          {
            type: "text" as const,
            text: `${procedure(thread.providerId, found.role)} Source: ${found.source}. ${APPLIES}`,
          },
        ],
      };
    },
  });

  bb.agents.configure((context) => {
    const saved = readRole(context.pluginMetadata.role);
    const instructions = saved
      ? procedure(context.provider.id, saved)
      : "No role is saved on this thread yet. Call role_choice and follow what it returns. Regular does the work in this session. Orchestrator delegates.";
    // The tool list is fixed when the provider session is built, but the role can be saved
    // later (first dispatch, or a Role switch mid-session). Always expose spawn; execute()
    // refuses it unless the live role is orchestrator.
    return {
      tools: ["role_choice", "spawn"],
      skills: ["role-picker"],
      instructions,
    };
  });
}
