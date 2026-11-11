import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { defineRpcContract, type BbPluginApi, type PluginInteractionResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { SHIPPED_AGENTS } from "./agents.generated.js";
import {
  ASK_RENDERER_ID,
  ASK_TIMEOUT_MS,
  askAnswers,
  askCancelledMessage,
  askTitle,
  buildAskPayload,
  describeAsk,
  formatAskOutput,
  parseAskArgs,
  parseAskInput,
} from "./lib/ask.js";
import {
  ACCOUNT_CATEGORIES,
  blockKey,
  parseQuotaBlock,
  QUOTA_CATEGORIES,
  quotaBlockEnd,
  reviewerModelKey,
  type QuotaBlock,
} from "./lib/quota-block.js";
import { resolveReviewHostId, usageLimitsQuery, usageSkip } from "./lib/review-skip.js";

export const ROLES = ["regular", "orchestrator", "interviewer"] as const;
const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

const ROLE_LABELS: Record<Role, string> = {
  regular: "Regular",
  orchestrator: "Orchestrator",
  interviewer: "Prompt generator",
};

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

// Copilot model ids are the copilot-acp picker ids, <model>[-standard][-<effort>]: no -standard
// is the 1M context tier. A bare id such as gpt-6.1-terra is not in the picker and the thread
// silently falls back to auto, so every Copilot id here carries -medium.
// Both GitHub Copilot providers: the user's own account and the SopraSteria account. They run
// the same launcher, agents, and logic; only the gh login differs. A thread on one stays on it.
const COPILOT_PROVIDERS = new Set(["acp-github-copilot-cli", "acp-github-copilot-sopra"]);

// The non-Argon Gemini on Antigravity, the third reviewer for a Claude worker. Change it here only.
export const ANTIGRAVITY_GEMINI_FALLBACK = "gemini-3.8-flash";

// Reviewers by id. Fallback order is per worker provider in REVIEW_ORDER.
const REVIEWERS: Record<string, SpawnSpec> = {
  gemini: { providerId: "acp-antigravity", model: "gemini-4-argon", reasoningLevel: "medium" },
  "copilot-opus": { providerId: "acp-github-copilot-cli", model: "claude-opus-5.5-medium", reasoningLevel: "medium", sessionOptions: { agent: "reviewer" } },
  "copilot-sol": { providerId: "acp-github-copilot-cli", model: "gpt-6.1-sol-medium", reasoningLevel: "medium", sessionOptions: { agent: "reviewer" } },
  "gemini-alt": { providerId: "acp-antigravity", model: ANTIGRAVITY_GEMINI_FALLBACK, reasoningLevel: "medium" },
  "claude-opus": { providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium" },
  codex: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" },
  // cantrip-review: its model and instructions come from the agent file.
  cursor: { providerId: "acp-cursor", agent: { dir: ".cursor", name: "cantrip-review.md" } },
};

// The reviewer chain for a worker on a provider, tried in order when one runs out of quota.
// No entry runs on the worker's provider. No exact provider and model pair appears twice, so two
// steps may share a provider when they use separately limited models (Antigravity's Argon and
// Gemini fallback). Copilot and Cursor review inside themselves on another vendor's model
// (Copilot's GPT worker gets Opus; Cursor gets cantrip-review on Meta's Muse).
// A Claude worker is never reviewed by a Claude model (Opus or Haiku). Everyone else gets
// Opus 5.5 second, unless it is already first.
const REVIEW_ORDER: Record<string, string[]> = {
  "claude-code": ["gemini", "copilot-sol", "gemini-alt", "cursor"],
  "acp-github-copilot-cli": ["copilot-opus"],
  "acp-github-copilot-sopra": ["copilot-opus"],
  "acp-cursor": ["cursor"],
  "acp-antigravity": ["copilot-opus", "codex", "claude-opus"],
  codex: ["gemini", "claude-opus", "copilot-sol"],
};

const SAME_PROVIDER_REVIEW = new Set([...COPILOT_PROVIDERS, "acp-cursor"]);

export function reviewChain(parentProviderId: string): SpawnSpec[] {
  const order = REVIEW_ORDER[parentProviderId] ?? ["gemini", "claude-opus", "codex"];
  // Copilot and Cursor review their own work on another vendor's model; everyone else leaves their provider.
  const excluded = new Set<string>(SAME_PROVIDER_REVIEW.has(parentProviderId) ? [] : [parentProviderId]);
  const seen = new Set<string>();
  const chain: SpawnSpec[] = [];
  for (const id of order) {
    const base = REVIEWERS[id];
    if (!base) continue;
    // A Copilot worker's review runs on that same Copilot account, never the other one.
    const spec = COPILOT_PROVIDERS.has(parentProviderId) && COPILOT_PROVIDERS.has(base.providerId)
      ? { ...base, providerId: parentProviderId }
      : base;
    if (excluded.has(spec.providerId)) continue;
    const key = `${spec.providerId}\u0000${reviewerModelKey(spec)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    chain.push(spec);
  }
  return chain;
}

// Records written before chains held specs stored reviewer ids.
function reviewerAt(record: ReviewRecord, index: number): SpawnSpec {
  const entry = record.chain[index];
  return typeof entry === "string" ? REVIEWERS[entry] : entry;
}

/** A reviewer as provider/model, for messages: the step's provider and the model it runs on. */
function reviewerLabel(spec: SpawnSpec): string {
  return `${spec.providerId}/${reviewerModelKey(spec)}`;
}

function chainProviders(record: ReviewRecord): string {
  return record.chain.map((_, i) => reviewerLabel(reviewerAt(record, i))).join(", ");
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
  if (COPILOT_PROVIDERS.has(parentProviderId)) {
    const copilot = {
      explore: { model: "claude-haiku-5.5-medium", reasoningLevel: "medium", sessionOptions: { agent: "explorer" } },
      contribute: { model: "gpt-6.1-terra-medium", reasoningLevel: "medium", sessionOptions: { agent: "worker" } },
      plan: { model: "claude-opus-5.5-medium", reasoningLevel: "medium", sessionOptions: { agent: "planner" } },
    }[name];
    return { providerId: parentProviderId, ...copilot };
  }
  return { providerId: parentProviderId };
}

const DEFAULT_BLOCK_MS = 60 * 60 * 1000;

// Some providers do not fail the turn on quota: they reply with a short notice and complete the turn.
// Antigravity: "⚠ Individual quota reached. ... Resets in 144h15m35s." Copilot: "Error: You have
// exceeded your monthly quota (Request ID: …)".
const QUOTA_NOTICE = new RegExp(
  [
    String.raw`\bquota (?:reached|exceeded|exhausted)\b`,
    String.raw`\b(?:usage|rate) limit (?:reached|exceeded)\b`,
    String.raw`\bexceeded (?:your|the) (?:\w+ )?quota\b`,
    String.raw`\bout of (?:\w+ )?quota\b`,
    String.raw`\bquota (?:has been|was|is) (?:reached|exceeded|exhausted)\b`,
  ].join("|"),
  "i",
);

/** The reset time from a provider's quota notice, when the reply is one. Null when it is not. */
export function quotaNoticeUntil(text: string | null, now = Date.now()): number | null {
  const trimmed = text?.trim() ?? "";
  // A review report is long and starts with CLEAN or ESCALATE; a quota notice is one short line.
  if (!trimmed || trimmed.length > 400 || /^(?:CLEAN|ESCALATE)\b/.test(trimmed)) return null;
  if (!QUOTA_NOTICE.test(trimmed)) return null;
  const resets = trimmed.match(/resets in\s+((?:\d+\s*[dhms]\s*)+)/i)?.[1];
  if (!resets) return now + DEFAULT_BLOCK_MS;
  const unit: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
  let ms = 0;
  for (const [, n, u] of resets.matchAll(/(\d+)\s*([dhms])/gi)) ms += Number(n) * unit[u.toLowerCase()];
  return now + (ms || DEFAULT_BLOCK_MS);
}

type ReviewRecord = {
  orchestratorId: string;
  worker: string;
  body: string;
  chain: (SpawnSpec | string)[];
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

// Waiting is the expensive part of orchestration: a wake-up after the provider's prompt cache
// expired (5 minutes on Anthropic) re-sends the whole conversation at cache-write price.
const ORCHESTRATOR_WAITING = [
  "bb wakes you when a spawned thread ends its turn: you receive a [bb system] @thread:<id> completed message. So after spawning, when nothing else is ready, end your turn with a one-line status. Do not poll: no bb thread wait loops, sleeps, or heartbeat automations.",
  "When woken, read bb thread output <id> before you use the report.",
  "Use bb thread wait <id> --timeout 4m only when you must block inside a turn, and repeat it rather than raising the timeout: the prompt cache expires after 5 minutes without a model call, and every wake-up after that re-sends the whole conversation at full price.",
].join(" ");

const INTERVIEWER_ASK_TOOL =
  "Ask through the AskUserQuestion tool (the question card), one question at a time, or at most three independent ones in one call. Never put a wall of questions in chat. Give 2-4 concrete options, put the one you recommend first and mark it, and let the user write their own answer. If the tool is missing, dismissed, or times out, ask that one question in your reply and end the turn.";

// GitHub Copilot has no question tool in bb (no plugin tools, no ask_user in ACP), so it asks
// through the CLI, which opens the same card.
const INTERVIEWER_ASK_CLI =
  "Ask with bb plugin run role-picker ask --questions-stdin, piping the questions as one line of JSON (the same schema as AskUserQuestion: {\"questions\":[{\"question\",\"header\" (at most 12 chars),\"options\":[{\"label\",\"description\"}] (2-4),\"multiSelect\":false}]}), one question at a time, or at most three independent ones in one call. Never put the JSON inside shell quotes. On macOS/Linux use bash with a quoted heredoc, three lines: bb plugin run role-picker ask --questions-stdin <<'EOF', then the JSON, then EOF. On Windows use powershell with a single-quoted here-string, three lines: @', then the JSON, then '@ | bb plugin run role-picker ask --questions-stdin. Run it in sync mode with a long initial_wait (600) and keep calling read_bash (read_powershell on Windows) until it finishes: it shows the question card and blocks until the user answers, then prints the answers as JSON. Never put a wall of questions in chat. Give 2-4 concrete options, put the one you recommend first and mark it, and let the user write their own answer. If it printed the answers JSON, use them whatever the exit code. If it exits 1 with an input error, fix the JSON and run it again. Otherwise, with no answers (the user dismissed the card or it timed out), ask that one question in your reply and end the turn.";

const INTERVIEWER_PROCEDURE = (ask: string) => [
  "Role: prompt generator. You work like a business analyst: you turn the user's idea into a prompt for an Orchestrator thread. You do not do the work.",
  "Read-only. Do not create, edit, or delete files, do not commit, and run only read-only commands. Do not call spawn except with name explore (or bb plugin run role-picker spawn explore when the spawn tool is missing), only in a non-Personal project, and only for a narrow question whose answer depends on codebase facts. Wait with bb thread wait <id> --timeout 4m, repeated while the explorer is still running (never longer per call, so the prompt cache stays warm), then read bb thread output <id>. Never spawn contribute, plan, or review.",
  "Context first, briefly. Run bb status once (if bb fails, use node \"$BB_CLI\" status). If the project is Personal (proj_personal), there is no project, or the check fails, do not read, list, or search any files: interview only. In any other project, take one quick look inside the thread's workspace only (README, top-level layout, files plainly tied to the topic), then start asking. Never read or search outside the workspace (home folders, vaults, other repos), never grep recursively over large trees, and run no other bb diagnostics. Your first message to the user is a question.",
  ask,
  "Order. Ask a question only once the answers it depends on are settled. Cover what the task needs: the goal and the problem behind it; who it is for and what outcome means success; scope and explicit non-goals; constraints (technology, compatibility, security, data, time, cost); acceptance criteria that can be checked; priorities and what to cut first; risks, unknowns, and dependencies. Keep a helicopter view. Go into technical detail only where it changes scope, risk, or acceptance.",
  "Challenge. Do not agree passively. Push back on vague goals, hidden assumptions, scope creep, criteria nobody can test, and answers that contradict earlier ones. Say why and offer a sharper alternative. If the conversation already answers something, state it as an assumption for the user to confirm instead of asking.",
  "Stateless. Use only this conversation and what you read now. Do not save memories, notes, or files.",
  "Stop when every section below is settled or the user has explicitly left it open. Summarise the decisions in a short list and ask once whether anything is wrong or missing.",
  "Handoff. Show the final prompt in chat as one fenced markdown block. After it, write only one line: paste this into a new thread with Role set to Orchestrator. Do not start a thread and do not write a file. Sections: ## Goal (one or two sentences, the outcome and why); ## Context (background, current state, relevant repositories, paths, systems, links); ## Scope, with ### Non-goals; ## Constraints (technical, compatibility, security, process, deadlines); ## Acceptance criteria (numbered, each observable or testable); ## Open risks (each with the user's priority); ## Suggested first steps (2-5 opening moves for the Orchestrator: what to explore or plan first, not an implementation).",
  "Write it for an Orchestrator that has not seen this conversation: self-contained, imperative, no filler, nothing addressed back to the user.",
].join(" ");

export function procedure(providerId: string, role: Role): string {
  if (role === "regular") {
    return "Role: regular. This is the default thread: do the work in this session and use any agents or tools you need.";
  }
  if (role === "interviewer") return INTERVIEWER_PROCEDURE(COPILOT_PROVIDERS.has(providerId) ? INTERVIEWER_ASK_CLI : INTERVIEWER_ASK_TOOL);
  return [
    "You spawn only. Do not explore, plan, contribute, or review in this session yourself: delegate with spawn or the Task tool.",
    "Call spawn with name explore, contribute, plan, or review. The assignment is only the task.",
    "Planning is the default: spawn plan before any contribute. Skip it only when ALL hold: the change is small (about one file or a few lines), the request is unambiguous, the approach is obvious with no design choices, and no exploration is needed to know where or what to edit. State the skip in one line. When in doubt, plan. Multi-file changes, new features, refactors, bug fixes with an unknown root cause, and cross-component behavior always get a plan. Sequence: explore (if needed), plan, contribute, review.",
    PLAN_IS_DESIGN,
    "spawn returns the thread id as soon as the thread exists. " + ORCHESTRATOR_WAITING,
    "Do not name the model and do not say which agent it is. spawn reads that from the agent file.",
    "explore may use the terminal. contribute is the only one that edits.",
    "Review loop: spawn contribute first and read its report when bb wakes you. Then spawn review with worker set to the contribute thread id. The reviewer sends defects straight to that worker, which fixes them and replies, up to two rounds. A wake-up from the worker's fix round (output starting FIXED round or BLOCKED) while its reviewer is still running needs no action: end your turn again. Act on the reviewer's output alone: CLEAN, or ESCALATE with the findings left. On ESCALATE, tell the same worker to fix the remaining findings. Do not ask the user.",
    "Each review runs on a provider other than the worker's. If a reviewer stops on a provider quota, the plugin moves the review to the next provider and messages you the new reviewer thread id: use that one's report instead. If a reviewer ends in error and no such message comes, spawn review again with the same worker; spawn skips providers that are out of quota.",
    SPAWN_FALLBACK,
    "You may also use the Task tool (in-session subagents such as explorer, planner, worker, reviewer) for short, bounded delegation. Use spawn for anything that should be its own bb thread, and always for review.",
  ].join(" ");
}

const PLAN_IS_DESIGN =
  "plan designs; it does not diagnose. Finding a root cause, reading CI or job logs, reproducing a failure, and mapping unfamiliar code are explore's work, so a bug with an unknown cause is explore first, then plan. Give plan the explorer's findings (cause, evidence, paths) and ask only for the implementation plan. Never ask plan to investigate or find a root cause.";

function planProtocol(): string {
  return [
    "Plan only. Your assignment carries the findings. Read only the code, tests, and configuration needed to design the change and confirm those findings.",
    "Do not diagnose: do not fetch CI or job logs, reproduce failures, or search for an unknown root cause. If the assignment asks you to find a cause, or its findings are missing or contradicted by the code, stop and report the specific questions the explorer must answer instead of investigating.",
  ].join("\n");
}

// GitHub Copilot rejects BB's stdio tool bridge (bb-bridge), so spawn and role_choice never reach it.
const SPAWN_FALLBACK =
  "If spawn or role_choice is not in your tool list (GitHub Copilot does not load BB plugin tools), use the same thing from the terminal: bb plugin run role-picker show prints your role, and bb plugin run role-picker spawn <explore|contribute|plan|review> --assignment-file <path> [--worker <thr_id>] spawns exactly like the spawn tool (write the assignment to a file first. In bash: cat > \"$BB_THREAD_STORAGE/<name>.md\" <<'EOF', then the assignment, then EOF on its own line. In PowerShell: @' on its own line, the assignment, then '@ | Set-Content -LiteralPath \"$env:BB_THREAD_STORAGE\\<name>.md\" -Encoding utf8. Then pass --assignment-file \"$BB_THREAD_STORAGE/<name>.md\". The name is letters, digits, dot, underscore or hyphen, ending in .md. --assignment <text> is only for a one-line assignment; never put a command substitution in --assignment, because bash 3.2 breaks on apostrophes and the guard denies it). Use that bb plugin run form, not the bb roles shorthand: on Windows the shorthand can crash at exit with a libuv assertion and a non-zero code even though the command worked. Never stop and report that spawn is missing.";

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
    "Then run bb thread wait " + workerId + " --timeout 4m, and repeat it while the worker is still running; never wait longer than 4 minutes per call, because the prompt cache expires after 5 minutes without a model call and every later call re-sends the whole conversation at full price. Then read bb thread output " + workerId + ". Go on only when it starts with FIXED round N or BLOCKED for the round you sent. If it does not, wait again, at most two more times. If the worker is idle and still has no FIXED or BLOCKED reply for your round, treat the round as BLOCKED. Then review the changed code again.",
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
      options: [...ROLES],
      experimental_optionLabels: ROLE_LABELS,
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
      "Spawn one of the four agents: explore, contribute, plan, or review. Plan before any contribute unless the change is small and obvious. Returns the thread id immediately. A review takes the contribute thread id as worker and sends its defects straight to that worker. The orchestrator does no other work. The prompt generator role may call spawn with name explore only.",
    instructions:
      "Orchestrators delegate with spawn (or the Task tool for short in-session work). If this spawn tool is missing (GitHub Copilot does not load BB plugin tools), run bb plugin run role-picker spawn <name> --assignment-file <path> [--worker <thr_id>] instead; it is identical. The only names are explore, contribute, plan, and review. contribute is the worker. plan only designs: root causes, logs, and investigation go to explore first, and plan gets the findings. Planning is the default: spawn plan before contribute, and skip it only when the change is small, unambiguous, obvious, and needs no exploration (state the skip in one line). spawn returns the thread id immediately, and bb wakes you when that thread ends its turn: end your turn instead of polling. Review loop: spawn contribute and read its report when woken; then spawn review with worker set to the contribute thread id. The reviewer sends defects to that worker and reports to you only at the end: CLEAN, or ESCALATE. Ignore wake-ups from the worker's fix rounds while its reviewer runs. Read bb thread output <id> before using a report. The prompt generator role may call spawn with name explore only.",
    presentation: {
      label: { pending: "Spawning agent", completed: "Spawned agent" },
    },
    parameters: z.object({
      name: spawnName,
      assignment: z.string().min(1),
      worker: z.string().min(1).optional().describe("Required for review: the contribute thread id whose diff is reviewed. Not used by the other names."),
    }).strict(),
    async execute(input, ctx) {
      const result = await spawnAgent(ctx.threadId, input);
      return { ...(result.ok ? {} : { isError: true }), content: [{ type: "text" as const, text: result.text }] };
    },
  });

  type SpawnResult = { ok: boolean; text: string };

  /** Shared by the spawn tool and `bb plugin run role-picker spawn`: GitHub Copilot drops BB's stdio tool bridge, so it needs the CLI. */
  async function spawnAgent(
    threadId: string,
    { name, assignment, worker: workerParam }: { name: SpawnName; assignment: string; worker?: string },
  ): Promise<SpawnResult> {
      const ctx = { threadId };
      const parent = await bb.sdk.threads.get({ threadId: ctx.threadId });
      const mode = await roleForThread(ctx.threadId);
      const fail = (text: string): SpawnResult => ({ ok: false, text });
      const allowed = mode.role === "orchestrator" || (mode.role === "interviewer" && name === "explore");
      if (!allowed) {
        return fail(mode.role === "interviewer"
          ? "The prompt generator may spawn explore only."
          : "spawn is only for the orchestrator role, or explore for the prompt generator.");
      }
      const clean = (id: string) => id.trim().replace(/^@thread:/, "");
      const whenDone = (id: string) => mode.role === "interviewer"
        ? [
          "Wait with bb thread wait " + id + " --timeout 4m, repeated while it is still running, then read bb thread output " + id + ".",
        ]
        : [
          "bb wakes you with a [bb system] message when it ends its turn. Until then, end your turn if nothing else is ready; do not poll.",
          "Then read the report before you use it: bb thread output " + id,
        ];
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
          return fail(`No reviewer is available: every review provider for a ${parent.providerId} worker (${chainProviders(record)}) is out of quota or unavailable. Independent review did not run. Do not ask the user. Continue, and commit and propagate on the worker's verification.`);
        }
        return {
          ok: true,
          text: [
            `Spawned review as ${spawned.id} on ${spawned.providerId}. Status: ${spawned.status}.`,
            "spawn returns when the thread exists. It does not wait for the agent.",
            "If this reviewer stops on a provider quota, you get a message with the replacement reviewer id; use that one's report instead.",
            ...whenDone(spawned.id),
          ].join("\n"),
        };
      }
      const spec = spawnSpec(parent.providerId, name);
      const defined = spec.agent ? agentDefinition(spec.agent, (message) => bb.log.warn(message)) : undefined;
      const protocol = name === "contribute" ? workerProtocol() : name === "plan" ? planProtocol() : "";
      const prompt = [
        defined?.body,
        "Assignment:\n" + body,
        protocol,
      ].filter((part): part is string => Boolean(part)).join("\n\n");

      const child = await bb.sdk.threads.spawn({
        projectId: parent.projectId,
        providerId: spec.providerId,
        parentThreadId: ctx.threadId,
        parentNotifications: "auto",
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
        ok: true,
        text: [
          `Spawned ${name} as ${child.id}. Status: ${child.status}.`,
          "spawn returns when the thread exists. It does not wait for the agent.",
          ...whenDone(child.id),
        ].join("\n"),
      };
  }

  // A path a CLI caller passes is on the invoking thread's machine, not necessarily the server's.
  async function readInvokerFile(threadId: string, cwd: string | undefined, filePath: string): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
    const thread = await bb.sdk.threads.get({ threadId });
    const hostId = thread.environmentId
      ? (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId
      : undefined;
    const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(filePath) || !cwd ? filePath : path.join(cwd, filePath);
    try {
      const file = await bb.sdk.files.read({ path: absolute, ...(hostId ? { hostId } : {}) });
      if (!("content" in file)) return { ok: false, error: `Could not read ${absolute}.` };
      return { ok: true, text: file.contentEncoding === "base64" ? Buffer.from(file.content, "base64").toString("utf8") : file.content };
    } catch (error) {
      return { ok: false, error: `Could not read ${absolute}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  bb.cli.register({
    name: "roles",
    summary: "Role picker: show this thread's role, spawn explore/contribute/plan/review (the spawn tool), or ask the user with a question card (AskUserQuestion); for providers without BB plugin tools such as GitHub Copilot",
    commands: [
      { name: "show", summary: "Print this thread's role and its procedure (same as role_choice)", usage: "bb roles show" },
      {
        name: "spawn",
        summary: "Spawn explore, contribute, plan, or review from this thread (same as the spawn tool)",
        usage: "bb roles spawn <explore|contribute|plan|review> (--assignment <text> | --assignment-file <path>) [--worker <thr_id>]",
      },
      {
        name: "ask",
        summary: "Ask the user with a question card and wait for the answer (AskUserQuestion, for providers without BB plugin tools such as GitHub Copilot). Prints {\"answers\":[{question,header,selected,freeText?}]}; exit 2 when the card is dismissed or times out (30 min)",
        usage: "bb roles ask (--questions-stdin | --questions '<json>' | --questions-file <path>); --questions-stdin reads one line of JSON from stdin (no shell quoting: bash <<'EOF' heredoc, PowerShell @' '@ here-string piped in); JSON as AskUserQuestion: {\"questions\":[{\"question\",\"header\" (<=12 chars),\"options\":[{\"label\",\"description\",\"preview\"?}] (2-4),\"multiSelect\"?}] (1-10)}",
      },
    ],
    async run(argv, cli) {
      const fail = (stderr: string, exitCode = 1) => ({ exitCode, stderr: stderr + "\n" });
      const threadId = cli.threadId;
      if (!threadId) return fail("Run this from a bb thread (BB_THREAD_ID is not set).");
      const [command, ...rest] = argv;
      if (command === "show") {
        const found = await roleForThread(threadId);
        const thread = await bb.sdk.threads.get({ threadId });
        return { exitCode: 0, stdout: `${procedure(thread.providerId, found.role)} Source: ${found.source}. ${APPLIES}\n` };
      }
      if (command === "ask") {
        const args = parseAskArgs(rest);
        if (!args.ok) return fail(args.error);
        let raw: string;
        if (args.source.kind === "file") {
          const file = await readInvokerFile(threadId, cli.cwd, args.source.path);
          if (!file.ok) return fail(file.error);
          raw = file.text;
        } else {
          raw = args.source.json;
        }
        const parsed = parseAskInput(raw);
        if (!parsed.ok) return fail(`${parsed.error}\nFix the questions and run bb roles ask again.`);
        const payload = buildAskPayload(parsed.input);
        let result: PluginInteractionResult;
        try {
          result = await bb.ui.requestInput(
            {
              threadId,
              rendererId: ASK_RENDERER_ID,
              title: askTitle(parsed.input),
              payload,
              timeoutMs: ASK_TIMEOUT_MS,
              presentation: { label: { pending: "Asking a question", completed: "Asked" }, icon: { glyph: "MessageQuestion" } },
              describeSubmission: (value) => describeAsk(askAnswers(payload, value)),
            },
            { signal: cli.signal },
          );
        } catch (error) {
          return fail(`Could not show the question card: ${error instanceof Error ? error.message : String(error)}. Ask the question in chat instead and end your turn.`, 2);
        }
        if (result.outcome === "cancelled") return { exitCode: 2, stderr: askCancelledMessage(result.reason) };
        return { exitCode: 0, stdout: formatAskOutput(askAnswers(payload, result.value)) };
      }
      if (command !== "spawn") return fail("Usage: bb roles show | bb roles spawn <explore|contribute|plan|review> (--assignment <text> | --assignment-file <path>) [--worker <thr_id>] | bb roles ask (--questions-stdin | --questions '<json>' | --questions-file <path>)", 2);
      const parsedName = spawnName.safeParse(rest[0]);
      if (!parsedName.success) return fail(`bb roles spawn needs a name: explore, contribute, plan, or review. Got "${rest[0] ?? ""}".`, 2);
      const options: Record<string, string> = {};
      for (let i = 1; i < rest.length; i++) {
        const match = /^--(assignment|assignment-file|worker)(?:=(.*))?$/s.exec(rest[i]);
        if (!match) return fail(`Unknown argument "${rest[i]}". Use --assignment, --assignment-file, or --worker.`, 2);
        const value = match[2] ?? rest[++i];
        if (value === undefined) return fail(`--${match[1]} needs a value.`, 2);
        options[match[1]] = value;
      }
      if (options.assignment !== undefined && options["assignment-file"] !== undefined) {
        return fail("Pass --assignment or --assignment-file, not both.", 2);
      }
      let assignment = options.assignment;
      if (options["assignment-file"] !== undefined) {
        const file = await readInvokerFile(threadId, cli.cwd, options["assignment-file"]);
        if (!file.ok) return fail(file.error);
        assignment = file.text;
      }
      if (!assignment?.trim()) return fail("bb roles spawn needs a non-empty --assignment or --assignment-file.", 2);
      const result = await spawnAgent(threadId, {
        name: parsedName.data,
        assignment,
        ...(options.worker ? { worker: options.worker } : {}),
      });
      return result.ok ? { exitCode: 0, stdout: result.text + "\n" } : fail(result.text);
    },
  });

  // Quota tracking. A provider that failed a reviewer on quota is skipped until its window resets.
  const kv = bb.storage.kv;
  const reviewKey = (threadId: string) => `review:${threadId}`;

  /** The reason a stored block is still active, or null when there is none or it has expired. */
  async function activeBlock(key: string): Promise<string | null> {
    const stored = await kv.get<unknown>(key);
    if (stored === undefined || stored === null) return null;
    const block = parseQuotaBlock(stored);
    const end = block ? quotaBlockEnd(block) : 0;
    if (block && Date.now() < end) return `quota block until ${new Date(end).toISOString()}`;
    await kv.delete(key);
    return null;
  }

  /** Why a reviewer step is skipped, or null when it can be tried. */
  async function skipReason(spec: SpawnSpec, hostId: string | null): Promise<string | null> {
    const providerId = spec.providerId;
    const model = reviewerModelKey(spec);
    // The provider-wide key is read first: it also holds blocks written before blocks were per model.
    const blocked = (await activeBlock(blockKey(providerId))) ?? (await activeBlock(blockKey(providerId, model)));
    if (blocked) return blocked;
    // Best effort: a provider whose usage report shows a used-up window, or no usable login, is skipped.
    // hostId is the machine the reviewer will run on. Without one, install status says nothing about that machine.
    try {
      const usage = await Promise.race([
        bb.sdk.system.usageLimits(usageLimitsQuery(providerId, hostId)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      return usageSkip(usage?.[providerId], Boolean(hostId), spec.model);
    } catch {
      // No usage report for this provider; assume it is available.
    }
    return null;
  }

  async function spawnReviewer(
    record: ReviewRecord,
    replaces?: string,
  ): Promise<{ id: string; status: string; providerId: string } | null> {
    let hostId: string | null = null;
    try {
      hostId = await resolveReviewHostId(record, {
        getEnvironment: (environmentId) => bb.sdk.environments.get({ environmentId }),
        getProject: (projectId) => bb.sdk.projects.get({ projectId }),
      });
    } catch {
      hostId = null;
    }
    for (let index = record.index; index < record.chain.length; index++) {
      const spec = reviewerAt(record, index);
      const providerId = spec.providerId;
      const skip = await skipReason(spec, hostId);
      if (skip) {
        bb.log.info(`review skips ${reviewerLabel(spec)} (${skip}) on ${hostId ?? "no resolved host"} for worker ${record.worker}`);
        continue;
      }
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
          parentNotifications: "auto",
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

  // A reviewer stopped on its provider's quota: block that provider until the reset, stop the
  // reviewer, start the next one in the chain, and tell the orchestrator.
  // scope "model" blocks only the failed reviewer's model; "provider" blocks every model on its provider.
  async function moveReview(threadId: string, until: number, reason: string, scope: "model" | "provider"): Promise<void> {
    const record = await kv.get<ReviewRecord>(reviewKey(threadId));
    if (!record) return;
    // Delete first, so a second event for the same reviewer does not move the review twice.
    await kv.delete(reviewKey(threadId));

    const failed = reviewerAt(record, record.index);
    const failedName = scope === "provider" ? failed.providerId : reviewerLabel(failed);
    const block: QuotaBlock = { until, setAt: Date.now() };
    await kv.set(blockKey(failed.providerId, scope === "provider" ? undefined : reviewerModelKey(failed)), block);
    const blockedUntil = new Date(quotaBlockEnd(block)).toISOString();

    // Stop the failed reviewer so a core retry after the window resets does not run a second review.
    await bb.sdk.threads.archive({ threadId }).catch(() => undefined);

    const next = await spawnReviewer({ ...record, index: record.index + 1 }, threadId);
    const stopped = `Reviewer ${threadId} on ${failedName} stopped: provider quota reached (${reason}). ${failedName} is skipped for reviews until ${blockedUntil}.`;
    const text = next
      ? [
          stopped,
          `The review moved to ${next.id} on ${next.providerId}, for worker ${record.worker}.`,
          `bb wakes you when the new reviewer ends its turn; then read bb thread output ${next.id}.`,
        ].join("\n")
      : [
          stopped,
          `No other review provider is available for worker ${record.worker} (tried ${chainProviders(record)}). Independent review did not run. Do not ask the user. Continue, and commit and propagate on the worker's verification.`,
        ].join("\n");
    bb.log.info(text);
    await bb.sdk.threads
      .send({ threadId: record.orchestratorId, mode: "auto", input: [{ type: "text", text, mentions: [] }] })
      .catch((error) => bb.log.warn(`could not tell orchestrator ${record.orchestratorId}: ${String(error)}`));
  }

  bb.events.on("turn.failed", async (event) => {
    const category = event.errorInfo?.category;
    const quota = (category && QUOTA_CATEGORIES.has(category)) || event.rateLimits?.status === "blocked";
    if (!quota) return;
    const resets = (event.rateLimits?.windows ?? [])
      .filter((w) => w.status === "blocked" && typeof w.resetsAtMs === "number")
      .map((w) => w.resetsAtMs as number);
    const until = resets.length ? Math.max(...resets) : Date.now() + DEFAULT_BLOCK_MS;
    // Billing, budget and login failures describe the account, so they block the whole provider.
    const scope = category && ACCOUNT_CATEGORIES.has(category) ? "provider" : "model";
    await moveReview(event.threadId, until, category ?? "rate limit", scope);
  });

  // Providers that report quota as a reply and complete the turn (Antigravity, Copilot).
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    const until = quotaNoticeUntil(lastAssistantText);
    if (until === null) return;
    await moveReview(thread.id, until, "quota notice", "model");
  });

  bb.agents.registerTool({
    name: "role_choice",
    description: "Read the role selected in the composer Role control for this thread.",
    instructions: "Call role_choice before development work and follow the role it returns. If role_choice is not in your tool list, run bb plugin run role-picker show instead.",
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
      : "No role is saved on this thread yet. Call role_choice (or run bb plugin run role-picker show if that tool is missing) and follow what it returns. Regular does the work in this session. Orchestrator delegates. Prompt generator interviews the user and writes a prompt for an Orchestrator thread; it does not edit.";
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
