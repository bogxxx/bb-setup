// Explorer: a treemap of the current folder across the full width, then tabs
// and a table whose rows can be selected and deleted.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "./components/ui/button";
import { Checkbox } from "./components/ui/checkbox";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import { cn } from "./lib/utils";
import { FOLDED, PROTECTED } from "./shared";
import type { Entry, GroupId, Node } from "./shared";
import { ago, formatBytes, GROUP_COLOR, plural } from "./format";
import { DeleteButton, HoverBody, useDelete, useStorage } from "./ui";

const [NAME, SIZE, FREES, MODIFIED, GROUP, KIDS, FLAGS, LABEL] = [
  0, 1, 2, 3, 4, 5, 6, 7,
] as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Squarified treemap: rows of tiles whose aspect ratio stays near 1. */
export function squarify<T>(items: T[], size: (item: T) => number, rect: Rect) {
  const out: (Rect & { item: T })[] = [];
  const total = items.reduce((sum, item) => sum + size(item), 0);
  if (total <= 0) return out;
  const scale = (rect.w * rect.h) / total;
  let queue = items
    .map((item) => ({ item, area: size(item) * scale }))
    .filter((n) => n.area > 0);
  let { x, y, w, h } = rect;
  const worst = (row: { area: number }[], side: number) => {
    const s = row.reduce((a, n) => a + n.area, 0);
    const max = Math.max(...row.map((n) => n.area));
    const min = Math.min(...row.map((n) => n.area));
    return Math.max(
      (side * side * max) / (s * s),
      (s * s) / (side * side * min),
    );
  };
  while (queue.length > 0) {
    const side = Math.min(w, h);
    let count = 1;
    while (
      count < queue.length &&
      worst(queue.slice(0, count + 1), side) <=
        worst(queue.slice(0, count), side)
    ) {
      count++;
    }
    const row = queue.slice(0, count);
    queue = queue.slice(count);
    const thick = row.reduce((a, n) => a + n.area, 0) / side;
    let offset = 0;
    for (const n of row) {
      const length = n.area / thick;
      out.push(
        w >= h
          ? { x, y: y + offset, w: thick, h: length, item: n.item }
          : { x: x + offset, y, w: length, h: thick, item: n.item },
      );
      offset += length;
    }
    if (w >= h) {
      x += thick;
      w -= thick;
    } else {
      y += thick;
      h -= thick;
    }
  }
  return out;
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

const pathOf = (names: string[]) => "/" + names.join("/");
const kidsOf = (node: Node) => (node[KIDS] || []) as Node[];
/** A path with the home folder written as "~". */
const tilde = (path: string, home = "") =>
  home && (path === home || path.startsWith(`${home}/`))
    ? `~${path.slice(home.length)}`
    : path;
const isFolder = (node: Node) => node[KIDS] !== 0 && !(node[FLAGS] & FOLDED);

interface Tile extends Rect {
  node: Node;
  names: string[];
  depth: number;
  framed: boolean;
}

/** Lay out a folder's children, and their children inside big enough tiles. */
function layoutTiles(
  node: Node,
  rect: Rect,
  names: string[],
  depth: number,
  out: Tile[],
) {
  for (const tile of squarify(kidsOf(node), (n) => n[SIZE], rect)) {
    // Too small to see: leave the space to the parent instead of a sliver.
    if (tile.w < 6 || tile.h < 6) continue;
    const childNames = [...names, tile.item[NAME]];
    const framed =
      depth < 2 &&
      isFolder(tile.item) &&
      kidsOf(tile.item).length > 0 &&
      tile.w > 110 &&
      tile.h > 64;
    out.push({ ...tile, node: tile.item, names: childNames, depth, framed });
    if (framed) {
      layoutTiles(
        tile.item,
        { x: tile.x + 3, y: tile.y + 20, w: tile.w - 6, h: tile.h - 23 },
        childNames,
        depth + 1,
        out,
      );
    }
  }
}

function Treemap({
  folder,
  names,
  onOpen,
}: {
  folder: Node;
  names: string[];
  onOpen: (names: string[]) => void;
}) {
  const { snapshot, hover, unhover } = useStorage();
  const [ref, width] = useWidth();
  const height = 320;
  const tiles = useMemo(() => {
    const out: Tile[] = [];
    if (width > 0)
      layoutTiles(folder, { x: 0, y: 0, w: width, h: height }, names, 0, out);
    return out;
  }, [folder, names, width]);
  return (
    <div
      ref={ref}
      className="relative"
      style={{ height }}
      onMouseLeave={unhover}
    >
      {tiles.map(({ x, y, w, h, node, names: tileNames, depth, framed }) => {
        const color = GROUP_COLOR[node[GROUP]];
        const folded = Boolean(node[FLAGS] & FOLDED);
        return (
          <button
            key={tileNames.join("/")}
            type="button"
            onClick={() => isFolder(node) && onOpen(tileNames)}
            onMouseMove={(event) =>
              hover(
                event,
                <HoverBody
                  color={color}
                  name={node[LABEL]?.split(" · ")[0] ?? node[NAME]}
                  path={
                    folded
                      ? undefined
                      : tilde(pathOf(tileNames), snapshot?.home)
                  }
                  facts={[
                    ["Size", formatBytes(node[SIZE])],
                    ["Frees", formatBytes(node[FREES])],
                    ["Modified", ago(node[MODIFIED])],
                  ]}
                />,
              )
            }
            className={cn(
              "absolute flex flex-col justify-start overflow-hidden rounded-[4px] text-left",
              // Padding only on tiles with a label, so small ones keep their size.
              framed ? "px-1.5 py-0.5" : w > 56 && h > 30 && "px-1.5 py-1",
              isFolder(node)
                ? "cursor-pointer hover:brightness-95 dark:hover:brightness-125"
                : "cursor-default",
            )}
            style={{
              left: x + 1,
              top: y + 1,
              width: Math.max(0, w - 2),
              height: Math.max(0, h - 2),
              background: `color-mix(in oklab, ${color} ${folded ? 6 : 14 + depth * 8}%, var(--background))`,
              boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${color} 30%, transparent)`,
            }}
          >
            {framed ? (
              <span className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="truncate font-medium text-foreground">
                  {node[NAME]}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatBytes(node[SIZE])}
                </span>
              </span>
            ) : (
              w > 56 &&
              h > 30 && (
                <>
                  <span className="block truncate text-[11px] font-medium text-foreground">
                    {node[NAME]}
                  </span>
                  <span className="block truncate text-[11px] tabular-nums text-muted-foreground">
                    {formatBytes(node[SIZE])}
                  </span>
                </>
              )
            )}
          </button>
        );
      })}
    </div>
  );
}

interface Row {
  path: string;
  name: string;
  where?: string;
  icon: string;
  modified: number;
  size: number;
  frees: number;
  /** Folder names to open on click; files and folded rows have none. */
  open?: string[];
  muted?: boolean;
  deletable: boolean;
}

const GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_96px_80px_36px] items-center gap-x-2";

/** Rows with checkboxes; a selection turns the header into a delete bar. */
function FileTable({
  rows,
  onOpen,
}: {
  rows: Row[];
  onOpen: (names: string[]) => void;
}) {
  const del = useDelete();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const picked = rows.filter((r) => selected.has(r.path));
  const deletable = rows.filter((r) => r.deletable);
  const all = deletable.length > 0 && picked.length === deletable.length;
  useEffect(() => setSelected(new Set()), [rows]);
  const toggle = (path: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  return (
    <div>
      <div
        className={cn(
          GRID,
          "h-9 border-b border-border/70 px-2 text-xs text-muted-foreground",
        )}
      >
        <Checkbox
          aria-label="Select all"
          checked={all ? true : picked.length > 0 ? "indeterminate" : false}
          disabled={deletable.length === 0}
          onCheckedChange={(on) =>
            setSelected(
              on === true ? new Set(deletable.map((r) => r.path)) : new Set(),
            )
          }
        />
        {picked.length > 0 ? (
          <div className="col-span-4 flex items-center gap-3">
            <span className="text-foreground">
              {plural(picked.length, "item")} selected ·{" "}
              {formatBytes(picked.reduce((t, r) => t + r.frees, 0))}
            </span>
            <Button
              variant="destructive"
              size="sm"
              className="h-7"
              onClick={() => del(picked)}
            >
              <Icon name="Trash2" />
              Delete
            </Button>
            <button
              type="button"
              className="cursor-pointer hover:text-foreground"
              onClick={() => setSelected(new Set())}
            >
              Deselect
            </button>
          </div>
        ) : (
          <>
            <span>Name</span>
            <span className="text-right">Modified</span>
            <span className="text-right">Size</span>
            <span />
          </>
        )}
      </div>
      {rows.map((row) => (
        <div
          key={row.path}
          className={cn(
            GRID,
            "group h-10 rounded-md px-2 text-sm",
            selected.has(row.path) ? "bg-state-active" : "hover:bg-state-hover",
          )}
        >
          {row.deletable ? (
            <Checkbox
              aria-label={`Select ${row.name}`}
              checked={selected.has(row.path)}
              onCheckedChange={(on) => toggle(row.path, on === true)}
            />
          ) : (
            <span />
          )}
          <button
            type="button"
            disabled={!row.open}
            onClick={() => row.open && onOpen(row.open)}
            className={cn(
              "flex min-w-0 items-center gap-2 text-left",
              row.open && "cursor-pointer",
            )}
          >
            <Icon
              name={row.icon}
              className="size-4 shrink-0 text-muted-foreground"
            />
            <span
              className={cn(
                "truncate",
                row.muted ? "text-muted-foreground" : "text-foreground",
              )}
            >
              {row.name}
            </span>
            {row.where && (
              <span className="min-w-0 truncate text-xs text-subtle-foreground/75">
                {row.where}
              </span>
            )}
          </button>
          <span className="text-right text-xs text-muted-foreground">
            {ago(row.modified)}
          </span>
          <span className="text-right text-xs tabular-nums text-foreground">
            {formatBytes(row.size)}
          </span>
          <div className="flex justify-end">
            {row.deletable && (
              <DeleteButton name={row.name} onClick={() => del([row])} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function entryRows(entries: Entry[], home: string): Row[] {
  return entries.map((entry) => {
    const names = entry.path.split("/").filter(Boolean);
    return {
      path: entry.path,
      name: names[names.length - 1] ?? entry.path,
      where: tilde(pathOf(names.slice(0, -1)), home),
      icon: entry.folder ? "Folder" : "File",
      modified: entry.modified,
      size: entry.size,
      frees: entry.frees,
      open: entry.folder ? names : names.slice(0, -1),
      deletable: entry.deletable,
    };
  });
}

/** The path on one line: as many trailing folders as fit, "…" for the rest. */
function Breadcrumb({
  path,
  setPath,
}: {
  path: string[];
  setPath: (names: string[]) => void;
}) {
  const { snapshot } = useStorage();
  const names = [snapshot?.rootLabel ?? "Disk", ...path];
  const [ref, width] = useWidth();
  const [skip, setSkip] = useState(0);
  const key = path.join("/");
  useLayoutEffect(() => setSkip(0), [key, width]);
  useLayoutEffect(() => {
    const element = ref.current;
    if (
      element &&
      element.scrollWidth > element.clientWidth &&
      skip < names.length - 1
    )
      setSkip(skip + 1);
  });
  return (
    <div
      ref={ref}
      className="-my-1 flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden whitespace-nowrap py-1 text-sm"
    >
      {skip > 0 && (
        <span className="shrink-0 px-1 text-muted-foreground">…</span>
      )}
      {names.map((name, index) =>
        index < skip ? null : (
          <span
            key={index}
            className={cn(
              "inline-flex items-center gap-0.5",
              index === skip && skip === names.length - 1
                ? "min-w-0"
                : "shrink-0",
            )}
          >
            {index > 0 && <span className="text-muted-foreground">/</span>}
            <button
              type="button"
              className={cn(
                "cursor-pointer truncate rounded px-1 py-0.5 hover:bg-state-hover",
                index === names.length - 1
                  ? "font-medium text-foreground"
                  : "text-muted-foreground",
              )}
              onClick={() => setPath(path.slice(0, index))}
            >
              {name}
            </button>
          </span>
        ),
      )}
    </div>
  );
}

function FileTypes() {
  const { snapshot } = useStorage();
  const types = snapshot?.types ?? [];
  const max = Math.max(1, ...types.map((t) => t.size));
  return (
    <div className="space-y-3 px-2 py-2">
      {types.map((type) => (
        <div key={type.label}>
          <div className="flex items-baseline justify-between gap-4 text-sm">
            <span className="truncate text-foreground">{type.label}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {formatBytes(type.size)}
            </span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-foreground/40"
              style={{ width: `${(type.size / max) * 100}%` }}
            />
          </div>
          <p className="mt-1 truncate text-xs text-subtle-foreground/75">
            {plural(type.count, "file")} ·{" "}
            {type.exts
              .map(
                ([ext, size]) =>
                  `${ext.startsWith("@") ? ext.slice(1) : `.${ext}`} ${formatBytes(size)}`,
              )
              .join(", ")}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The folder at a path from the server, refetched whenever the data changes. */
function useFolder(path: string[]) {
  const { rpc, version, hostId } = useStorage();
  const [folder, setFolder] = useState<{
    path: string;
    node: Node | null;
  } | null>(null);
  const key = pathOf(path);
  useEffect(() => {
    let live = true;
    rpc.call("storageFolder", { hostId, path: key }).then(
      (next) => live && setFolder(next ?? { path: key, node: null }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [rpc, hostId, key, version]);
  // Null while loading, undefined when the scan doesn't have the folder.
  if (folder?.path !== key) return null;
  return folder.node ?? undefined;
}

const TABS = [
  ["contents", "Contents"],
  ["largest", "Largest files"],
  ["types", "File types"],
  ["stale", "Stale"],
];

export function Explorer() {
  const { snapshot } = useStorage();
  const [path, setPath] = useState<string[]>([]);
  const [tab, setTab] = useState("contents");
  const folder = useFolder(path);
  // The open folder may be gone after a Clean: go up to one the scan has.
  useEffect(() => {
    if (folder === undefined && path.length > 0) setPath(path.slice(0, -1));
  }, [folder, path]);
  const contents: Row[] = useMemo(
    () =>
      folder
        ? kidsOf(folder).map((node) => {
            const names = [...path, node[NAME]];
            const folded = Boolean(node[FLAGS] & FOLDED);
            return {
              path: pathOf(names),
              name: node[NAME],
              where: node[LABEL],
              icon: folded
                ? "MoreHorizontal"
                : node[KIDS] !== 0
                  ? "Folder"
                  : "File",
              modified: node[MODIFIED],
              size: node[SIZE],
              frees: node[FREES],
              open: isFolder(node) ? names : undefined,
              muted: folded,
              deletable: !(node[FLAGS] & PROTECTED),
            };
          })
        : [],
    [folder, path],
  );
  const largest = useMemo(
    () => entryRows(snapshot?.largest ?? [], snapshot?.home ?? ""),
    [snapshot],
  );
  const stale = useMemo(
    () => entryRows(snapshot?.stale ?? [], snapshot?.home ?? ""),
    [snapshot],
  );
  if (!snapshot?.scannedAt) return null;
  const reveal = (names: string[]) => {
    setPath(names);
    setTab("contents");
  };
  return (
    <section className="space-y-3">
      <div className="flex min-w-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Up"
          className="size-7 shrink-0"
          disabled={path.length === 0}
          onClick={() => setPath(path.slice(0, -1))}
        >
          <Icon name="ArrowUp" className="size-3.5" />
        </Button>
        <Breadcrumb path={path} setPath={setPath} />
        <span className="ml-auto shrink-0 text-sm tabular-nums text-muted-foreground">
          {folder ? formatBytes(folder[SIZE]) : ""}
        </span>
      </div>
      {folder ? (
        <Treemap folder={folder} names={path} onOpen={reveal} />
      ) : (
        <div style={{ height: 320 }} />
      )}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-8">
          {TABS.map(([value, label]) => (
            <TabsTrigger key={value} value={value} className="text-xs">
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="contents">
          <FileTable rows={contents} onOpen={reveal} />
        </TabsContent>
        <TabsContent value="largest">
          <FileTable rows={largest} onOpen={reveal} />
        </TabsContent>
        <TabsContent value="types">
          <FileTypes />
        </TabsContent>
        <TabsContent value="stale">
          <p className="px-2 pb-1 text-xs text-subtle-foreground/75">
            Over 500 MB, unchanged for 60 days.
          </p>
          <FileTable rows={stale} onOpen={reveal} />
        </TabsContent>
      </Tabs>
    </section>
  );
}
