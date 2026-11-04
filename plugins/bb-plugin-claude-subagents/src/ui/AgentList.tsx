import type { AgentRow } from "../contract";
import { formatCount, formatDuration, staleText, statusLabel } from "./format";

export function AgentList({
  agents,
  counts,
  truncated,
  now,
  onOpen,
  onRefresh,
}: {
  agents: AgentRow[];
  counts: Record<AgentRow["status"], number>;
  truncated: boolean;
  now: number;
  onOpen: (familyId: string) => void;
  onRefresh: () => void;
}) {
  const summary = (["in_progress", "finished", "failed", "interrupted"] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${statusLabel(status).toLowerCase()}`)
    .join(" · ");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="text-xs text-muted-foreground">{summary || "Claude subagents"}</p>
        <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={onRefresh}>
          Refresh
        </button>
      </div>
      {truncated ? <p className="px-3 py-2 text-xs text-muted-foreground">The list is capped.</p> : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {agents.length === 0 ? (
          <p className="px-3 py-6 text-sm text-muted-foreground">No Claude subagents on this thread yet.</p>
        ) : (
          <ul>
            {agents.map((agent) => (
              <li key={agent.familyId} className="border-b border-border">
                <button type="button" className="flex w-full flex-col gap-1 px-3 py-2 text-left hover:bg-muted/40" onClick={() => onOpen(agent.familyId)}>
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-sm text-foreground">{agent.description || agent.familyId}</span>
                    <StatusPill status={agent.status} />
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {[
                      agent.agentType,
                      agent.model.resolved ?? agent.model.requested,
                      agent.usage
                        ? `latest run ${formatCount(agent.usage.totalTokens)} tokens · ${formatCount(agent.usage.toolUses)} tools · ${formatDuration(agent.usage.durationMs)}`
                        : null,
                      agent.runCount > 1 ? `${agent.runCount} runs` : null,
                      agent.stale ? staleText(agent.updatedAt, now) : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {agent.error ? <span className="text-xs text-destructive">{agent.error}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: AgentRow["status"] }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
      {status === "in_progress" ? (
        <span className="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent" aria-hidden="true" />
      ) : null}
      {statusLabel(status)}
    </span>
  );
}
