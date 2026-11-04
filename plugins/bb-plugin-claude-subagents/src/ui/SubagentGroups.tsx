import type { AgentRow, DisplayStatus } from "../contract";
import { statusLabel } from "./format";

const groups: { status: DisplayStatus; heading: string; summary: string }[] = [
  { status: "in_progress", heading: "Still working", summary: "still working" },
  { status: "finished", heading: "Finished", summary: "finished" },
  { status: "failed", heading: "Failed", summary: "failed" },
  { status: "interrupted", heading: "Interrupted", summary: "interrupted" },
];

export function subagentCountSummary(counts: Record<DisplayStatus, number>): string {
  return groups
    .filter((group) => counts[group.status] > 0)
    .map((group) => `${counts[group.status]} ${group.summary}`)
    .join(" · ");
}

export function SubagentGroups({
  agents,
  counts,
  selectedId,
  onOpen,
}: {
  agents: AgentRow[];
  counts: Record<DisplayStatus, number>;
  selectedId: string | null;
  onOpen: (familyId: string) => void;
}) {
  const visible = groups.filter((group) => counts[group.status] > 0);
  return (
    <div className="flex flex-col gap-2 py-1">
      {visible.map((group) => (
        <section key={group.status} aria-label={group.heading}>
          <h4 className="px-2 text-[11px] text-muted-foreground">{group.heading}</h4>
          <ul>
            {agents
              .filter((agent) => agent.status === group.status)
              .map((agent) => (
                <li key={agent.familyId}>
                  <button
                    type="button"
                    data-status={agent.status}
                    aria-pressed={selectedId === agent.familyId}
                    className={
                      agent.status === "in_progress"
                        ? "flex w-full items-center justify-between gap-2 bg-primary/10 px-2 py-1 text-left"
                        : "flex w-full items-center justify-between gap-2 px-2 py-1 text-left"
                    }
                    onClick={() => onOpen(agent.familyId)}
                  >
                    <span className="min-w-0 truncate text-xs text-foreground">{agent.description || agent.familyId}</span>
                    <span className={agent.status === "in_progress" ? "shrink-0 text-[11px] text-foreground" : "shrink-0 text-[11px] text-muted-foreground"}>
                      {statusLabel(agent.status)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
