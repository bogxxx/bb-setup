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

/** What the hover card says the agent last wrote. */
export interface PreviewAgent {
  text: string;
  completed: boolean;
}

/** Permissions copied onto an allow-once approval. Null for every other subject. */
export interface GrantedPermissions {
  fileSystem: { read: string[]; write: string[] } | null;
  network: { enabled: boolean | null } | null;
}

/** An approval the card can resolve with allow_once. */
export interface ApproveTarget {
  interactionId: string;
  grantedPermissions: GrantedPermissions | null;
}

/** What the thread is waiting on the user for, when it is waiting. */
export interface PreviewYou {
  text: string;
  approve: ApproveTarget | null;
}

export interface ThreadPreview {
  agent: PreviewAgent | null;
  you: PreviewYou | null;
}

/** Collapse whitespace and drop a leading heading or list marker, repeatedly. */
function conciseLine(text: string): string {
  let line = text.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 3 && line.length > 0; i++) {
    const next = line.replace(/^(?:#{1,6} |[-*+] |\d+[.)] )/, "").trim();
    if (next === line) break;
    line = next;
  }
  return line;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

type WalkMark = { kind: "turn"; status: string } | { kind: "hit" };

function latestAgent(rows: readonly unknown[]): PreviewAgent | null {
  const marks: WalkMark[] = [];
  const hits: { text: string; enclosing: string | null; at: number }[] = [];
  const visit = (list: readonly unknown[], enclosing: string | null) => {
    for (const row of list) {
      if (!isRecord(row)) continue;
      if (row.kind === "turn") {
        const status = typeof row.status === "string" ? row.status : "";
        marks.push({ kind: "turn", status });
        if (Array.isArray(row.children)) visit(row.children, status);
        continue;
      }
      if (row.kind !== "conversation" || row.role !== "assistant" || typeof row.text !== "string") continue;
      const text = conciseLine(row.text);
      if (!text) continue;
      marks.push({ kind: "hit" });
      hits.push({ text, enclosing, at: marks.length - 1 });
    }
  };
  visit(rows, null);
  const found = hits[hits.length - 1];
  if (!found) return null;
  const pendingFollows = marks.slice(found.at + 1).some((mark) => mark.kind === "turn" && mark.status === "pending");
  return { text: found.text, completed: found.enclosing === "completed" || !pendingFollows };
}

function presentationText(value: unknown): string {
  if (!isRecord(value)) return "";
  const title = str(value.title);
  if (title) return conciseLine(title);
  const label = isRecord(value.label) ? str(value.label.pending) : "";
  return label ? conciseLine(label) : "";
}

function questionText(questions: unknown): string {
  if (!Array.isArray(questions) || !isRecord(questions[0])) return "";
  const text = str(questions[0].shortLabel) || str(questions[0].prompt);
  return text ? conciseLine(text) : "";
}

function approvalSubjectLabel(subject: Record<string, unknown>): string {
  switch (subject.kind) {
    case "plan":
      return "Approve plan";
    case "file_change":
      return "Approve file edit";
    case "tool_use":
      return presentationText(subject.presentation) || "Approve";
    case "permission_grant":
      return "Approve permissions";
    case "command":
      return "Approve command";
    default:
      return "Approve";
  }
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const list: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    list.push(item);
  }
  return list;
}

function readPermissions(value: unknown): GrantedPermissions | null {
  if (!isRecord(value)) return null;
  let fileSystem: GrantedPermissions["fileSystem"] = null;
  if (value.fileSystem != null) {
    if (!isRecord(value.fileSystem)) return null;
    const read = stringList(value.fileSystem.read);
    const write = stringList(value.fileSystem.write);
    if (!read || !write) return null;
    fileSystem = { read, write };
  }
  let network: GrantedPermissions["network"] = null;
  if (value.network != null) {
    if (!isRecord(value.network)) return null;
    const enabled = value.network.enabled;
    if (enabled != null && typeof enabled !== "boolean") return null;
    network = { enabled: typeof enabled === "boolean" ? enabled : null };
  }
  return { fileSystem, network };
}

function approveTarget(item: Record<string, unknown>, payload: Record<string, unknown>, subject: Record<string, unknown>): ApproveTarget | null {
  const decisions = payload.availableDecisions;
  const interactionId = str(item.id);
  if (!interactionId || !Array.isArray(decisions) || !decisions.includes("allow_once")) return null;
  return {
    interactionId,
    grantedPermissions: subject.kind === "permission_grant" ? readPermissions(subject.permissions) : null,
  };
}

function youFromInteraction(item: Record<string, unknown>): PreviewYou {
  const payload = isRecord(item.payload) ? item.payload : {};
  if (payload.kind === "approval") {
    const subject = isRecord(payload.subject) ? payload.subject : {};
    const reason = str(payload.reason);
    return {
      text: (reason ? conciseLine(reason) : "") || approvalSubjectLabel(subject),
      approve: approveTarget(item, payload, subject),
    };
  }
  if (payload.kind === "user_question") {
    return { text: questionText(payload.questions) || "Waiting for your input", approve: null };
  }
  const text = presentationText(payload.presentation) || (str(payload.title) ? conciseLine(str(payload.title)) : "");
  return { text: text || "Waiting for your input", approve: null };
}

function workYouText(row: Record<string, unknown>): string {
  if (row.workKind === "question") return questionText(row.questions);
  if (row.workKind === "form") return presentationText(row.presentation) || (str(row.title) ? conciseLine(str(row.title)) : "");
  if (row.workKind === "approval") {
    if (row.approvalKind === "file-edit") return "Approve file edit";
    if (row.approvalKind === "permission-grant") return "Approve permissions";
    return "Approve";
  }
  return "";
}

function latestYouWork(rows: readonly unknown[]): string | null {
  let text: string | null = null;
  const visit = (list: readonly unknown[]) => {
    for (const row of list) {
      if (!isRecord(row)) continue;
      if (row.kind === "turn" && Array.isArray(row.children)) visit(row.children);
      if (row.kind === "work" && row.status === "pending" && YOU_WORK.has(String(row.workKind))) {
        const next = workYouText(row);
        if (next) text = next;
      }
    }
  };
  visit(rows);
  return text;
}

function pendingInteractions(interactions: readonly unknown[] | undefined): Record<string, unknown>[] {
  const pending: Record<string, unknown>[] = [];
  for (const item of interactions ?? []) {
    if (isRecord(item) && item.status === "pending") pending.push(item);
  }
  return pending;
}

/**
 * The latest assistant message, and what a waiting thread needs from you.
 * Work rows and tool names are never the agent line.
 */
export function threadPreview(
  rows: readonly unknown[],
  options?: { waiting?: boolean; interactions?: readonly unknown[] },
): ThreadPreview {
  const pending = pendingInteractions(options?.interactions);
  const waiting = options?.waiting === true || pending.length > 0;
  let you: PreviewYou | null = null;
  if (waiting) {
    const first = pending[0];
    you = first
      ? youFromInteraction(first)
      : { text: latestYouWork(rows) ?? "Waiting for your input", approve: null };
  }
  return { agent: latestAgent(rows), you };
}
