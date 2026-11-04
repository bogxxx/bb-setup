import { experimental_PluginRpcRefusal, PluginCliError, cliCommand, defineCli } from "@get-bb/plugin-sdk";
import type { ListSubagentsResult, SubagentDetailResult } from "./contract";

type Handlers = {
  list: (threadId: string) => Promise<ListSubagentsResult>;
  show: (threadId: string, familyId: string) => Promise<SubagentDetailResult>;
};

export function subagentsCommand(handlers: Handlers) {
  return defineCli({
    name: "claude-subagents",
    summary: "List Claude Code background agents and show one agent's usage, chat, and thinking.",
    commands: {
      list: cliCommand({
        summary: "List background agents on a thread. One row per agent, at most 200, in-progress first.",
        options: {
          thread: {
            type: "string",
            description: "Thread id (thr_…). Defaults to the current thread. Primary host only.",
          },
          json: { type: "boolean", description: "Print the list as JSON" },
        },
        async run(input, ctx) {
          const threadId = requireThread(input.options.thread, ctx.threadId);
          const result = await call(() => handlers.list(threadId));
          if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
          const lines = result.agents.map((agent) => {
            const model = agent.model.resolved ?? agent.model.requested ?? "model unknown";
            const runs = agent.runCount === 1 ? "" : ` ${agent.runCount} runs`;
            return `${agent.status}\t${agent.familyId}\t${agent.agentType ?? ""}\t${model}${runs}\t${agent.description}`;
          });
          const notice = result.notice ? `${result.notice}\n` : "";
          return { exitCode: 0, stdout: `${notice}${lines.join("\n")}${lines.length ? "\n" : ""}` };
        },
      }),
      show: cliCommand({
        summary: "Show one agent's models, transcript usage, chat, and thinking. Text is clipped.",
        positionals: [{ name: "familyId", description: "Agent family id", required: true }],
        options: {
          thread: {
            type: "string",
            description: "Thread id (thr_…). Defaults to the current thread.",
          },
          json: { type: "boolean", description: "Print the detail as JSON" },
        },
        async run(input, ctx) {
          const threadId = requireThread(input.options.thread, ctx.threadId);
          const result = await call(() => handlers.show(threadId, input.positionals.familyId));
          if (input.options.json) return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}\n` };
          const lines = [
            `${result.agent.status} ${result.agent.familyId} ${result.agent.agentType ?? ""} runs ${result.agent.runCount}`,
            `alias ${result.models.requestedAlias ?? ""} effort ${result.models.effort ?? ""} advisor ${result.models.advisor ?? ""}`,
            `resolved ${result.models.resolved.map((entry) => `${entry.model} ${entry.calls}`).join(", ")}`,
            `usage input ${result.usage.input} output ${result.usage.output} cacheCreate ${result.usage.cacheCreate} cacheRead ${result.usage.cacheRead} thinking ${result.usage.thinking} calls ${result.usage.apiCalls}`,
            result.thinking.note,
            result.transcript.notice ?? `transcript ${result.transcript.source}`,
          ];
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        },
      }),
    },
  });
}

function requireThread(flag: string | undefined, contextThreadId: string | undefined): string {
  const threadId = flag ?? contextThreadId;
  if (!threadId) {
    throw new PluginCliError("missing thread id", {
      code: "missing_thread",
      hint: "Pass --thread <thr_id>.",
    });
  }
  return threadId;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof experimental_PluginRpcRefusal) {
      throw new PluginCliError(error.message, { code: error.code });
    }
    throw error;
  }
}
