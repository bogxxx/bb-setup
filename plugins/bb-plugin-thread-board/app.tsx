// Thread Board: under the New thread message box, threads in needs you, done,
// or running, grouped by project. It reads BB's live thread list, including
// snoozed threads the sidebar hides, and lists every project, with the
// homepage's project first. A card opens its thread; right-click opens BB's
// thread menu, with Snooze and Archive.
import { memo, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  definePluginApp,
  experimental_ProviderIcon as ProviderIcon,
  experimental_ThreadActionsContextMenu as ThreadActionsContextMenu,
  experimental_useProviders,
  experimental_useSidebarThreads,
  useSettings,
  type PluginHomepageSectionProps,
  type PluginSidebarThread,
} from "@get-bb/plugin-sdk/app";
import { ago, board, COLUMNS, type BoardThread, type Card, type Column, type ProjectGroup, type Tag } from "./board";
import { CardHover, Chip } from "./steps";
import { cn } from "@/lib/utils";

type IconProvider = ComponentProps<typeof ProviderIcon>["provider"];

const DOT: Record<Column, string> = {
  needs: "bg-orange-500",
  done: "bg-muted-foreground/40",
  running: "bg-sky-500",
};

/** The clock the "9m ago" labels read, ticking once a minute. */
function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

function doneDaysOf(value: unknown): number {
  return typeof value === "number" && value > 0 ? value : 3;
}

type SidebarThread = ReturnType<typeof experimental_useSidebarThreads>["threads"][number];

function ProjectMark({ name }: { name: string }) {
  const letter = (name.trim().charAt(0) || "P").toUpperCase();
  return (
    <span className="flex size-4 shrink-0 items-center justify-center rounded bg-foreground/10 text-[10px] font-medium leading-none text-foreground">
      {letter}
    </span>
  );
}

const CardView = memo(function CardView({
  card,
  column,
  now,
  provider,
}: {
  card: Card;
  column: Column;
  now: number;
  provider: IconProvider | null;
}) {
  const t = card.thread as BoardThread & SidebarThread;
  const target = {
    id: t.id,
    projectId: t.projectId,
    parentThreadId: t.parentThreadId,
    parentNotifications: t.parentNotifications,
    archivedAt: t.archivedAt,
    pinnedAt: t.pinnedAt,
    sectionId: t.sectionId,
    isUnread: t.isUnread,
    status: t.status,
    environment: t.environment?.id ? { id: t.environment.id, path: t.environment.path } : null,
  };
  const tag = card.tag;
  return (
    <ThreadActionsContextMenu thread={target}>
      <div className="min-w-0">
        <CardHover threadId={t.id} title={t.displayTitle} tag={tag}>
          <a
            href={t.href}
            className="block rounded-lg border border-border bg-background px-3 py-2 shadow-xs transition-colors hover:bg-state-hover"
          >
            <div className="flex items-start gap-2">
              <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", DOT[column])} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{t.displayTitle}</span>
              <Chip tag={tag} />
            </div>
            <div className="mt-1 flex items-center gap-2 pl-3.5 text-xs text-muted-foreground">
              <span>{ago(t.updatedAt, now)}</span>
              {card.busyChildren > 0 && (
                <span>
                  · {card.busyChildren} {card.busyChildren === 1 ? "child" : "children"} running
                </span>
              )}
              <span className="ml-auto flex size-3.5 items-center justify-center">
                {provider && <ProviderIcon providerKind="agent" provider={provider} className="size-3.5" />}
              </span>
            </div>
          </a>
        </CardHover>
      </div>
    </ThreadActionsContextMenu>
  );
});

function ColumnView({
  column,
  label,
  groups,
  projects,
  providers,
  now,
}: {
  column: Column;
  label: string;
  groups: ProjectGroup[];
  projects: Map<string, string>;
  providers: Map<string, IconProvider>;
  now: number;
}) {
  const count = groups.reduce((n, g) => n + g.cards.length, 0);
  const [all, setAll] = useState(false);
  let left = all ? Infinity : 12;
  return (
    <section className="min-w-0 space-y-2" data-column={column}>
      <h3 className="flex items-center gap-1.5 text-sm">
        <span className={cn("size-1.5 rounded-full", DOT[column])} />
        <span className={cn("font-medium", count ? "text-foreground" : "text-muted-foreground")}>{label}</span>
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </h3>
      {groups.map((group) => {
        if (left <= 0) return null;
        const shown = group.cards.slice(0, left);
        left -= shown.length;
        const name = projects.get(group.projectId) ?? "Project";
        return (
          <div key={group.projectId} className="space-y-1.5">
            <span className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-1.5 py-0.5 text-xs font-medium text-foreground">
              <ProjectMark name={name} />
              <span className="truncate">{name}</span>
            </span>
            {shown.map((card) => (
              <CardView
                key={card.thread.id}
                card={card}
                column={column}
                now={now}
                provider={providers.get(card.thread.providerId) ?? { id: card.thread.providerId }}
              />
            ))}
          </div>
        );
      })}
      {count > 12 && (
        <button
          type="button"
          className="cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setAll(!all)}
        >
          {all ? "Show less" : `Show all ${count}`}
        </button>
      )}
    </section>
  );
}

function ThreadBoard({ projectId }: PluginHomepageSectionProps) {
  const { values } = useSettings();
  const { status, threads, projects } = experimental_useSidebarThreads();
  const { providers } = experimental_useProviders();
  const now = useNow();
  const doneDays = doneDaysOf(values?.doneDays);
  const columns = useMemo(
    () => board(threads as unknown as BoardThread[], now, doneDays, projectId),
    [threads, projectId, now, doneDays],
  );
  const projectNames = useMemo(
    () => new Map(projects.map((p) => [p.id, p.isPersonal ? "Personal" : p.name])),
    [projects],
  );
  const providerById = useMemo(() => new Map(providers.map((p) => [p.id, p as IconProvider])), [providers]);
  if (values?.showBoard === false || status !== "ready") return null;
  return (
    <div className="grid grid-cols-1 gap-6 pt-2 sm:grid-cols-3">
      {COLUMNS.map(({ id, label }) => (
        <ColumnView
          key={id}
          column={id}
          label={label}
          groups={columns[id]}
          projects={projectNames}
          providers={providerById}
          now={now}
        />
      ))}
    </div>
  );
}

type BoardMeta = {
  now: number;
  projects: Map<string, string>;
  chips: Map<string, Tag>;
};

function useBoardMeta(_input: { threads: readonly PluginSidebarThread[] }): BoardMeta {
  const { threads, projects } = experimental_useSidebarThreads();
  const { values } = useSettings();
  const now = useNow();
  const doneDays = doneDaysOf(values?.doneDays);
  return useMemo(() => {
    const columns = board(threads as unknown as BoardThread[], now, doneDays);
    const chips = new Map<string, Tag>();
    for (const column of COLUMNS) {
      for (const group of columns[column.id]) {
        for (const card of group.cards) {
          if (card.tag) chips.set(card.thread.id, card.tag);
        }
      }
    }
    return {
      now,
      chips,
      projects: new Map(projects.map((p) => [p.id, p.isPersonal ? "Personal" : p.name])),
    };
  }, [threads, projects, now, doneDays]);
}

function BoardMetaLine({ thread, data }: { thread: PluginSidebarThread; data: BoardMeta }) {
  const name = data.projects.get(thread.projectId) ?? "Project";
  const letter = (name.trim().charAt(0) || "P").toUpperCase();
  const chip = data.chips.get(thread.id) ?? null;
  return (
    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
      <span className="shrink-0">{ago(thread.updatedAt, data.now)}</span>
      <span className="inline-flex min-w-0 max-w-28 items-center gap-1 rounded bg-muted px-1 py-px text-[10px] font-medium text-foreground">
        <span className="flex size-3.5 shrink-0 items-center justify-center rounded bg-background text-[9px] leading-none">
          {letter}
        </span>
        <span className="truncate">{name}</span>
      </span>
      <Chip tag={chip} />
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.homepageSection({ id: "thread-board", title: "Board", component: ThreadBoard });
  app.slots.experimental_threadRowMetadata({
    id: "board-meta",
    order: 0,
    useData: useBoardMeta,
    component: BoardMetaLine,
  });
});
