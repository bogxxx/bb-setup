// What the board shows: every non-archived thread in one of three columns, and
// in each column grouped by project. Snoozed (hidden) threads stay. Pure, so
// it runs the same in tests.

/** The fields of BB's live sidebar thread that the board reads. */
export interface BoardThread {
  id: string;
  projectId: string;
  parentThreadId: string | null;
  displayTitle: string;
  originPluginId: string | null;
  providerId: string;
  status: string;
  queuedWork: string;
  hasPendingInteraction: boolean;
  indicator: string;
  isUnread: boolean;
  isHidden: boolean;
  isArchived: boolean;
  isPinned: boolean;
  activity: {
    workflows: number;
    backgroundAgents: number;
    backgroundCommands: number;
    planMode: number;
  };
  updatedAt: number;
  href: string;
}

export type Column = "needs" | "done" | "running";

/** The board's columns, in the order they show. */
export const COLUMNS: { id: Column; label: string }[] = [
  { id: "needs", label: "needs you" },
  { id: "done", label: "done" },
  { id: "running", label: "running" },
];

/** A short tag that says why a card sits where it does. */
export type Tag =
  | "question"
  | "failed"
  | "unread"
  | "send failed"
  | "queued"
  | "plan"
  | "agents"
  | "workflow"
  | "review"
  | "snoozed"
  | "pinned"
  | null;

export interface Card {
  thread: BoardThread;
  tag: Tag;
  /** Child threads under it that run or need you. */
  busyChildren: number;
}

export interface ProjectGroup {
  projectId: string;
  cards: Card[];
}

const BUSY = new Set(["starting", "active", "stopping"]);
const DAY = 86_400_000;
const YOU_WORK = new Set(["approval", "question", "form"]);

/** A role-picker reviewer child. A top-level thread titled "review" is not one. */
function isReviewer(t: BoardThread): boolean {
  return Boolean(t.parentThreadId) && t.displayTitle === "review";
}

/**
 * Why a thread needs you, or null. A child thread needs you only when it asks
 * or a message to it failed. A reviewer child in that spot is tagged review.
 * A hidden thread's unread or failed state counts only inside the done window.
 * A question or a failed send always counts.
 */
function needsYou(t: BoardThread, now: number, doneDays: number): Tag {
  const reviewer = isReviewer(t);
  if (t.hasPendingInteraction || t.indicator === "waiting-for-input") {
    return reviewer ? "review" : "question";
  }
  if (t.queuedWork === "failed" || t.indicator === "queued-failed") {
    return reviewer ? "review" : "send failed";
  }
  if (t.parentThreadId) return null;
  if (t.isHidden && now - t.updatedAt > doneDays * DAY) return null;
  if (t.indicator === "unread-error") return "failed";
  if (t.isUnread) return "unread";
  return null;
}

function running(t: BoardThread): Tag | false {
  if (BUSY.has(t.status)) return null;
  if (t.queuedWork === "waiting") return "queued";
  if (t.activity.planMode) return "plan";
  if (t.activity.workflows) return "workflow";
  if (t.activity.backgroundAgents || t.activity.backgroundCommands) return "agents";
  return false;
}

function doneTag(t: BoardThread): Tag {
  if (t.isHidden) return "snoozed";
  if (t.isPinned) return "pinned";
  return null;
}

/**
 * Sorts the threads into the columns. Archived threads are left out. Snoozed
 * threads stay: a child shows on its own card only when it asks or a send
 * failed, and otherwise counts toward its root, which runs while any of them
 * runs. A running card with a busy reviewer under it is tagged review instead
 * of agents. Done lists top-level threads touched in the last `doneDays` days,
 * and pinned threads after that. `firstProjectId` is that column's first group.
 */
export function board(
  threads: readonly BoardThread[],
  now: number,
  doneDays = 3,
  firstProjectId?: string | null,
): Record<Column, ProjectGroup[]> {
  const live = threads.filter((t) => !t.isArchived);
  const byId = new Map(live.map((t) => [t.id, t]));
  const rootOf = (t: BoardThread) => {
    let at = t;
    for (let i = 0; i < 50 && at.parentThreadId; i++) {
      const parent = byId.get(at.parentThreadId);
      if (!parent) break;
      at = parent;
    }
    return at;
  };
  const cards: Record<Column, Card[]> = { needs: [], done: [], running: [] };
  const busyUnder = new Map<string, number>();
  const reviewUnder = new Map<string, number>();
  const placed = new Set<string>();
  for (const t of live) {
    const need = needsYou(t, now, doneDays);
    if (need) {
      cards.needs.push({ thread: t, tag: need, busyChildren: 0 });
      placed.add(t.id);
      continue;
    }
    if (t.parentThreadId && running(t) !== false) {
      const root = rootOf(t);
      busyUnder.set(root.id, (busyUnder.get(root.id) ?? 0) + 1);
      if (isReviewer(t)) reviewUnder.set(root.id, (reviewUnder.get(root.id) ?? 0) + 1);
    }
  }
  for (const t of live) {
    if (t.parentThreadId || placed.has(t.id)) continue;
    const own = running(t);
    const kids = busyUnder.get(t.id) ?? 0;
    if (own !== false || kids > 0) {
      const tag: Tag = own === false ? "agents" : own;
      cards.running.push({
        thread: t,
        tag: tag === "agents" && (reviewUnder.get(t.id) ?? 0) > 0 ? "review" : tag,
        busyChildren: kids,
      });
    } else if (t.isPinned || now - t.updatedAt <= doneDays * DAY) {
      cards.done.push({ thread: t, tag: doneTag(t), busyChildren: 0 });
    }
  }
  const group = (list: Card[]): ProjectGroup[] => {
    const groups = new Map<string, Card[]>();
    for (const card of [...list].sort((a, b) => b.thread.updatedAt - a.thread.updatedAt)) {
      const key = card.thread.projectId;
      groups.set(key, [...(groups.get(key) ?? []), card]);
    }
    const ordered = [...groups].map(([projectId, items]) => ({ projectId, cards: items }));
    if (!firstProjectId) return ordered;
    const index = ordered.findIndex((g) => g.projectId === firstProjectId);
    if (index > 0) {
      const [first] = ordered.splice(index, 1);
      ordered.unshift(first!);
    }
    return ordered;
  };
  return { needs: group(cards.needs), done: group(cards.done), running: group(cards.running) };
}

/** "now", "9m ago", "8h ago", "3d ago". */
export function ago(ms: number, now: number) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stepLabel(row: Record<string, unknown>): string {
  const presentation = isRecord(row.presentation) ? row.presentation : null;
  const title = presentation?.title;
  if (typeof title === "string" && title.length > 0) return title;
  const label = presentation && isRecord(presentation.label) ? presentation.label : null;
  if (label) {
    const key = row.status === "pending" ? "pending" : "completed";
    const text = label[key];
    if (typeof text === "string" && text.length > 0) return text;
  }
  if (typeof row.toolName === "string" && row.toolName.length > 0) return row.toolName;
  if (typeof row.workKind === "string" && row.workKind.length > 0) return row.workKind;
  return "step";
}

function collectSteps(rows: unknown[], out: { label: string; status: string; actor: "agent" | "you" }[]) {
  for (const row of rows) {
    if (!isRecord(row)) continue;
    if (row.kind === "work") {
      const workKind = typeof row.workKind === "string" ? row.workKind : "";
      out.push({
        label: stepLabel(row),
        status: typeof row.status === "string" ? row.status : "",
        actor: YOU_WORK.has(workKind) ? "you" : "agent",
      });
    }
    if (row.kind === "turn" && Array.isArray(row.children)) collectSteps(row.children, out);
  }
}

/** The last `n` work rows under turns, in walk order. */
export function latestSteps(
  rows: unknown[],
  n = 5,
): { label: string; status: string; actor: "agent" | "you" }[] {
  const out: { label: string; status: string; actor: "agent" | "you" }[] = [];
  collectSteps(rows, out);
  const cap = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
  return out.slice(Math.max(0, out.length - cap));
}
