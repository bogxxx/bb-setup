import { Markdown } from "@get-bb/plugin-sdk/app";
import type { ChatItem, DetailFilter, SubagentDetailResult } from "../contract";
import { formatCount } from "./format";

const filters: { id: DetailFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "thinking", label: "Thinking" },
];

export function AgentDetail({
  detail,
  items,
  filter,
  onFilter,
  onBack,
  onEarlier,
}: {
  detail: SubagentDetailResult;
  items: ChatItem[];
  filter: DetailFilter;
  onFilter: (filter: DetailFilter) => void;
  onBack: () => void;
  onEarlier: () => void;
}) {
  const { agent, models, usage, thinking, transcript } = detail;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={onBack}>
          Back
        </button>
        <h2 className="min-w-0 truncate text-sm text-foreground">{agent.description || agent.familyId}</h2>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-auto px-3 py-3">
        <section className="space-y-1 text-xs">
          <p className="text-foreground">
            Resolved {models.resolved.map((entry) => `${entry.model} (${formatCount(entry.calls)} calls)`).join(", ") || "unknown"}
          </p>
          <p className="text-muted-foreground">
            Requested alias {models.requestedAlias ?? "unknown"}
            {models.requested.length > 0 ? ` · requested ${models.requested.join(", ")}` : ""}
            {models.effort ? ` · effort ${models.effort}` : ""}
            {models.advisor ? ` · advisor ${models.advisor}` : ""}
          </p>
        </section>
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
          <Usage label="Input" value={usage.input} />
          <Usage label="Output" value={usage.output} />
          <Usage label="Cache create" value={usage.cacheCreate} />
          <Usage label="Cache read" value={usage.cacheRead} />
          <Usage label="Thinking" value={usage.thinking} />
          <Usage label="API calls" value={usage.apiCalls} />
        </dl>
        <p className="text-sm text-foreground">{thinking.note}</p>
        {transcript.notice ? <p className="text-sm text-muted-foreground">{transcript.notice}</p> : null}
        {transcript.lagging ? (
          <p className="text-sm text-muted-foreground">The transcript lags the final result. The summary below is the completed event.</p>
        ) : null}
        {transcript.malformedLines > 0 ? (
          <p className="text-xs text-muted-foreground">Skipped {transcript.malformedLines} unreadable lines.</p>
        ) : null}
        <div className="flex gap-2">
          {filters.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={filter === entry.id}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-foreground"
              onClick={() => onFilter(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        {detail.page.hasEarlier ? (
          <button type="button" className="text-xs text-foreground underline-offset-2 hover:underline" onClick={onEarlier}>
            Load earlier
          </button>
        ) : null}
        <div className="space-y-3">
          {items.map((item) => (
            <ItemView key={item.index} item={item} thinkingState={thinking.state} />
          ))}
        </div>
        {detail.finalSummary ? (
          <section className="space-y-1 border-t border-border pt-3">
            <h3 className="text-xs text-muted-foreground">Summary</h3>
            <Markdown content={detail.finalSummary} />
          </section>
        ) : null}
      </div>
    </div>
  );
}

function Usage({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border px-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{formatCount(value)}</dd>
    </div>
  );
}

function ItemView({ item, thinkingState }: { item: ChatItem; thinkingState: SubagentDetailResult["thinking"]["state"] }) {
  if (item.kind === "user" || item.kind === "assistant") {
    return (
      <article className="space-y-1">
        <p className="text-xs text-muted-foreground">{item.kind === "user" ? "User" : item.model || "Assistant"}</p>
        <Markdown content={item.text} />
      </article>
    );
  }
  if (item.kind === "thinking") {
    const label = item.redacted ? "Redacted" : thinkingState === "summarized" ? "Summarized" : "Thinking";
    return (
      <details className="rounded-md border border-border px-2 py-1">
        <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
        {item.text ? <Markdown content={item.text} /> : null}
      </details>
    );
  }
  return (
    <article className="space-y-1 rounded-md border border-border px-2 py-1 text-xs">
      <p className="text-foreground">{item.name}</p>
      {item.input ? <pre className="overflow-auto whitespace-pre-wrap text-muted-foreground">{item.input}</pre> : null}
      {item.result ? (
        <p className={item.result.isError ? "text-destructive" : "text-muted-foreground"}>
          {item.result.isError ? "error" : "ok"} {item.result.text}
        </p>
      ) : null}
    </article>
  );
}
