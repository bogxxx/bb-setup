// Top of the page: free space, the disk bar, and one row per category with
// its Clean button and a list that unfolds under it.
import { useState } from "react";
import type { MouseEvent, ReactNode } from "react";
import { experimental_Icon as Icon, useSettings } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { cn } from "./lib/utils";
import { ago, formatBytes, GROUP_COLOR, plural } from "./format";
import type { GroupId, Item, Platform } from "./shared";
import { DeleteButton, HoverBody, useDelete, useStorage } from "./ui";

/** What each OS's categories hold and clean. */
const DETAILS: Record<
  Platform,
  { dev: string; trash: string; trashTitle: string; system: string }
> = {
  darwin: {
    dev: "Clean: DerivedData, package caches, builds, logs",
    trash: "Clean: everything in the Trash",
    trashTitle: "Clean Trash?",
    system: "macOS, swap, unreadable folders",
  },
  linux: {
    dev: "Clean: package caches, builds",
    trash: "Clean: everything in the Trash",
    trashTitle: "Clean Trash?",
    system: "Linux, unreadable folders",
  },
  win32: {
    dev: "Clean: package caches, builds, crash dumps",
    trash: "Clean: everything in the Recycle Bin",
    trashTitle: "Empty the Recycle Bin?",
    system: "Windows, page file, unreadable folders",
  },
};

/** The machines BB knows, as a row of buttons; hidden with only one. */
export function MachinePicker() {
  const { machines, hostId, setHostId } = useStorage();
  if (!machines || machines.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Machine">
      {machines.map((m) => (
        <Button
          key={m.id}
          variant={m.id === hostId ? "outline" : "ghost"}
          size="sm"
          role="radio"
          aria-checked={m.id === hostId}
          onClick={() => setHostId(m.id)}
          className={cn(!m.connected && "text-muted-foreground")}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              m.connected ? "bg-success" : "bg-muted-foreground/40",
            )}
          />
          {m.name}
          {m.primary && (
            <span className="text-xs text-muted-foreground">server</span>
          )}
        </Button>
      ))}
    </div>
  );
}

/** Why a machine's scan can't show: offline, or it didn't answer. */
export function Unreachable() {
  const { unreachable } = useStorage();
  if (!unreachable) return null;
  return (
    <div className="flex gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
      <Icon
        name="CloudOff"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <p className="text-sm text-foreground">{unreachable}</p>
    </div>
  );
}

const sizes = (items: { size: number }[]) =>
  items.reduce((t, i) => t + i.size, 0);
const frees = (items: { frees: number }[]) =>
  items.reduce((t, i) => t + i.frees, 0);

export function FreeSpace() {
  const { snapshot, rpc, hostId, hover, unhover } = useStorage();
  const nightly = useSettings().values?.nightlyScan !== false;
  if (!snapshot) return null;
  const tip = (event: MouseEvent, name: string, color: string, bytes: number) =>
    hover(
      event,
      <HoverBody
        color={color}
        name={name}
        facts={[
          ["Size", formatBytes(bytes)],
          [
            "Share",
            `${((bytes / snapshot.total) * 100).toFixed(1)}% of the disk`,
          ],
        ]}
      />,
    );
  const status = snapshot.scanning
    ? "Scanning… this takes a few minutes"
    : snapshot.error
      ? `Scan failed: ${snapshot.error}`
      : snapshot.scannedAt
        ? `Scanned ${ago(snapshot.scannedAt)}${nightly ? " · next at 00:00 UTC" : ""}`
        : "Not scanned yet";
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="text-foreground">
            <span className="text-3xl font-semibold tabular-nums tracking-tight">
              {formatBytes(snapshot.free)}
            </span>
            <span className="ml-2 text-sm text-muted-foreground">
              free of {formatBytes(snapshot.total)}
            </span>
          </p>
          <p
            className={cn(
              "mt-1 text-xs",
              snapshot.error ? "text-destructive" : "text-subtle-foreground/75",
            )}
          >
            {status}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={snapshot.scanning}
          onClick={() => void rpc.call("storageRescan", { hostId })}
        >
          <Icon
            name={snapshot.scanning ? "Spinner" : "ArrowReloadHorizontal"}
            className={cn(snapshot.scanning && "animate-spin")}
          />
          {snapshot.scannedAt ? "Rescan" : "Scan"}
        </Button>
      </div>
      <div
        className="mt-4 flex h-3 overflow-hidden rounded-full bg-muted"
        onMouseLeave={unhover}
      >
        {snapshot.groups.map((group) => (
          <div
            key={group.id}
            className="h-full border-r-2 border-background last:border-r-0 hover:opacity-80"
            style={{
              width: `${(group.bytes / snapshot.total) * 100}%`,
              background: GROUP_COLOR[group.id],
            }}
            onMouseMove={(event) =>
              tip(event, group.label, GROUP_COLOR[group.id], group.bytes)
            }
          />
        ))}
        <div
          className="h-full flex-1"
          onMouseMove={(event) =>
            tip(event, "Free", "var(--muted)", snapshot.free)
          }
        />
      </div>
    </div>
  );
}

/** Without Full Disk Access, macOS keeps Mail, Photos, and more from the scan. */
export function FullDiskAccess() {
  const { snapshot, rpc, hostId } = useStorage();
  if (!snapshot || snapshot.fullDiskAccess) return null;
  return (
    <div className="flex gap-2.5 rounded-lg bg-muted/60 px-3 py-2.5">
      <Icon
        name="Lock"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="min-w-0 flex-1 basis-56">
          <p className="text-sm font-medium text-foreground">
            Give BB Full Disk Access to see everything
          </p>
          <p className="mt-0.5 text-xs leading-snug text-subtle-foreground/75">
            macOS keeps Mail, Photos, Messages, the Trash, and browser profiles
            from the scan. Turn on bb in the list, then reopen BB.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void rpc.call("storageOpenFullDiskAccess", { hostId })}
        >
          Open System Settings
        </Button>
      </div>
    </div>
  );
}

/** One category: color, name, size, a Clean button, a list that unfolds. */
function CategoryRow({
  group,
  detail,
  onClean,
  children,
}: {
  group: GroupId;
  detail: string;
  onClean?: () => void;
  children?: ReactNode;
}) {
  const { snapshot } = useStorage();
  const [open, setOpen] = useState(false);
  const info = snapshot?.groups.find((g) => g.id === group);
  const size = group === "trash" ? snapshot?.trash : info?.bytes;
  return (
    <div className="border-b border-border/70 last:border-b-0">
      <div className="flex items-center gap-3 py-3">
        <button
          type="button"
          disabled={!children}
          onClick={() => setOpen(!open)}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2.5 text-left",
            children && "cursor-pointer",
          )}
        >
          <Icon
            name="ChevronRight"
            className={cn(
              "mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
              !children && "invisible",
            )}
          />
          <span
            className="mt-1.5 size-2.5 shrink-0 rounded-full"
            style={{ background: GROUP_COLOR[group] }}
          />
          <span className="min-w-0">
            <span className="block text-sm font-medium text-foreground">
              {info?.label}
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-subtle-foreground/75">
              {detail}
            </span>
          </span>
        </button>
        <span className="w-20 shrink-0 text-right text-sm tabular-nums text-foreground">
          {size == null ? "—" : formatBytes(size)}
        </span>
        <div className="flex w-20 shrink-0 justify-end">
          {onClean && (
            <Button variant="outline" size="sm" onClick={onClean}>
              Clean
            </Button>
          )}
        </div>
      </div>
      {open && <div className="pb-3 pl-5">{children}</div>}
    </div>
  );
}

/** A row of an unfolded list: name, details, a colored bar, size, delete. */
function ListItem({
  item,
  group,
  max,
}: {
  item: Item;
  group: GroupId;
  max: number;
}) {
  const del = useDelete();
  return (
    <div className="group flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-state-hover">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span
            className="shrink-0 truncate text-sm text-foreground"
            style={{ maxWidth: "60%" }}
          >
            {item.name}
          </span>
          {item.meta && (
            <span className="min-w-0 truncate text-xs text-subtle-foreground/75">
              {item.meta}
            </span>
          )}
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.max(1, (item.size / max) * 100)}%`,
              background: GROUP_COLOR[group],
            }}
          />
        </div>
      </div>
      <span className="w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {formatBytes(item.size)}
      </span>
      <div className="w-7 shrink-0">
        {item.deletable && (
          <DeleteButton name={item.name} onClick={() => del([item])} />
        )}
      </div>
    </div>
  );
}

/** A list, optionally titled: a few items, then "Show all" lets it scroll on. */
function List({
  items,
  group,
  title,
  cap = 5,
  max = Math.max(1, ...items.map((i) => i.size)),
}: {
  items: Item[];
  group: GroupId;
  title?: string;
  cap?: number;
  max?: number;
}) {
  const [all, setAll] = useState(false);
  if (items.length === 0) return null;
  return (
    <>
      {title && (
        <p className="flex justify-between px-2 pb-0.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-muted-foreground first:pt-1">
          <span>
            {title} · {items.length}
          </span>
          <span className="pr-10 tabular-nums">
            {formatBytes(sizes(items))}
          </span>
        </p>
      )}
      <div className={cn(all && "max-h-80 overflow-y-auto overscroll-contain")}>
        {(all ? items : items.slice(0, cap)).map((item) => (
          <ListItem
            key={item.path || item.name}
            item={item}
            group={group}
            max={max}
          />
        ))}
      </div>
      {items.length > cap && (
        <button
          type="button"
          onClick={() => setAll(!all)}
          className="cursor-pointer px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {all ? "Show less" : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

/** The lines of a Clean confirmation: what goes, and how much it frees. */
function Lines({ rows }: { rows: [string, number][] }) {
  return (
    <ul className="space-y-1">
      {rows.map(([label, bytes]) => (
        <li key={label} className="flex justify-between gap-6">
          <span>{label}</span>
          <span className="tabular-nums">{formatBytes(bytes)}</span>
        </li>
      ))}
    </ul>
  );
}

export function Categories() {
  const { snapshot, rpc, hostId, confirm } = useStorage();
  if (!snapshot?.scannedAt) return null;
  const words = DETAILS[snapshot.platform];
  const { archived, worktrees, live, agents } = snapshot.bb;
  const cleanable = snapshot.dev.filter((c) => c.inClean);
  const bbMax = Math.max(
    1,
    ...[...archived, ...worktrees, ...live, ...agents].map((i) => i.size),
  );
  const clean = (
    target: "bb" | "dev" | "trash",
    title: string,
    rows: [string, number][] = [],
  ) =>
    confirm({
      title,
      description: rows.length ? (
        <Lines rows={rows} />
      ) : (
        <p>Can’t be undone.</p>
      ),
      action: rows.length
        ? `Free ${formatBytes(rows.reduce((t, [, b]) => t + b, 0))}`
        : "Clean",
      run: () => rpc.call("storageClean", { hostId, target }),
    });
  return (
    <div className="border-y border-border/70">
      <CategoryRow
        group="bb"
        detail="Clean: archived threads, leftover worktrees"
        onClean={
          archived.length + worktrees.length === 0
            ? undefined
            : () =>
                clean("bb", "Clean BB?", [
                  [plural(archived.length, "archived thread"), frees(archived)],
                  [
                    plural(worktrees.length, "leftover worktree"),
                    frees(worktrees),
                  ],
                ])
        }
      >
        <List
          title="Archived threads"
          items={archived}
          group="bb"
          cap={3}
          max={bbMax}
        />
        <List
          title="Leftover worktrees"
          items={worktrees}
          group="bb"
          cap={3}
          max={bbMax}
        />
        <List
          title="Live threads"
          items={live}
          group="bb"
          cap={3}
          max={bbMax}
        />
        <List
          title="Agent data"
          items={agents}
          group="bb"
          cap={3}
          max={bbMax}
        />
      </CategoryRow>
      <CategoryRow
        group="dev"
        detail={words.dev}
        onClean={
          cleanable.length
            ? () =>
                clean(
                  "dev",
                  "Clean dev caches?",
                  cleanable.map((c) => [c.label, c.frees]),
                )
            : undefined
        }
      >
        <List
          group="dev"
          items={snapshot.dev.map((c) => ({
            path: c.path ?? c.id,
            name: c.label,
            meta: c.inClean
              ? "in Clean"
              : c.count > 1
                ? plural(c.count, "folder")
                : "",
            size: c.size,
            frees: c.frees,
            deletable: c.path !== null,
          }))}
        />
      </CategoryRow>
      <CategoryRow
        group="trash"
        detail={words.trash}
        onClean={() => clean("trash", words.trashTitle)}
      />
      <CategoryRow group="apps" detail={plural(snapshot.apps.length, "app")}>
        <List items={snapshot.apps} group="apps" />
      </CategoryRow>
      <CategoryRow group="files" detail="Projects, scratch, documents">
        <List items={snapshot.files} group="files" />
      </CategoryRow>
      <CategoryRow group="system" detail={words.system}>
        <List items={snapshot.system} group="system" />
      </CategoryRow>
    </div>
  );
}
