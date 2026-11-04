import { readFileSync } from "node:fs";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

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

function spawnSpec(parentProviderId: string, name: SpawnName): {
  providerId: string;
  model?: string;
  reasoningLevel?: string;
  sessionOptions?: Record<string, string>;
  file?: string;
} {
  if (parentProviderId === "acp-cursor") {
    const file = {
      explore: "C:\\Users\\krech\\.cursor\\agents\\cantrip-explore.md",
      contribute: "C:\\Users\\krech\\.cursor\\agents\\cantrip-implement.md",
      plan: "C:\\Users\\krech\\.cursor\\agents\\cantrip-plan.md",
      review: "C:\\Users\\krech\\.cursor\\agents\\cantrip-review.md",
    }[name];
    return { providerId: "acp-cursor", file };
  }
  if (parentProviderId === "claude-code") {
    if (name === "review") {
      return { providerId: "acp-antigravity", model: "gemini-4-argon", reasoningLevel: "medium" };
    }
    const claude = {
      explore: { model: "claude-haiku-5-5", file: "C:\\Users\\krech\\.claude\\agents\\explorer.md" },
      contribute: { model: "claude-haiku-5-5", file: "C:\\Users\\krech\\.claude\\agents\\worker.md" },
      plan: { model: "claude-opus-5-5", file: "C:\\Users\\krech\\.claude\\agents\\planner.md" },
    }[name];
    return { providerId: "claude-code", reasoningLevel: "medium", ...claude };
  }
  if (parentProviderId === "acp-github-copilot-cli") {
    const copilot = {
      explore: { model: "claude-haiku-5.5", sessionOptions: { agent: "explorer" } },
      contribute: { model: "gpt-6.1-terra", reasoningLevel: "medium", sessionOptions: { agent: "worker" } },
      plan: { model: "claude-opus-5.5", sessionOptions: { agent: "planner" } },
      review: { model: "claude-opus-5.5", reasoningLevel: "medium", sessionOptions: { agent: "reviewer" } },
    }[name];
    return { providerId: "acp-github-copilot-cli", ...copilot };
  }
  return { providerId: parentProviderId };
}

function agentDefinition(file: string): { model?: string; reasoningLevel?: string; serviceTier?: string; body: string } {
  const raw = readFileSync(file, "utf8");
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
    "spawn returns the thread id as soon as the thread exists. Wait with bb thread wait <id>, then read the report with bb thread output <id>, before you use it.",
    "Do not name the model and do not say which agent it is. spawn reads that from the agent file.",
    "explore may use the terminal. contribute is the only one that edits. review only reviews that diff.",
    "Do not use the Task tool.",
  ].join(" ");
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
      "Spawn one of the four agents: explore, contribute, plan, or review. Returns the thread id immediately. The orchestrator does no other work.",
    instructions:
      "Orchestrators call spawn only. The only names are explore, contribute, plan, and review. contribute is the worker. spawn returns the thread id immediately. Wait with bb thread wait <id>, then read bb thread output <id>, before using the report.",
    presentation: {
      label: { pending: "Spawning agent", completed: "Spawned agent" },
    },
    parameters: z.object({
      name: spawnName,
      assignment: z.string().min(1),
    }).strict(),
    async execute({ name, assignment }, ctx) {
      const parent = await bb.sdk.threads.get({ threadId: ctx.threadId });
      const mode = await roleForThread(ctx.threadId);
      if (mode.role !== "orchestrator") {
        return { isError: true, content: [{ type: "text" as const, text: "spawn is only for the orchestrator role." }] };
      }
      const spec = spawnSpec(parent.providerId, name);
      const defined = spec.file ? agentDefinition(spec.file) : undefined;
      const prompt = [
        defined?.body ?? "",
        "",
        "Assignment:",
        assignment,
      ].filter((line) => line !== "").join("\n");

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
