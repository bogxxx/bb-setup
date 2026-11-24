import { describe, expect, it } from "vitest";
import {
  assignGroups,
  bbItems,
  find,
  isProtected,
  removeFromTree,
  snapshot,
  type Context,
  type Scan,
  type ScanNode,
} from "./model";

const H = "/Users/me";
const DAY = 86400;
const NOW = 1_800_000_000;

/** A folder with its sizes summed from its children. */
function dir(n: string, k: ScanNode[], m = NOW): ScanNode {
  const sum = (key: "s" | "u" | "a" | "f") => k.reduce((t, c) => t + c[key], 0);
  return { n, s: sum("s"), u: sum("u"), a: sum("a"), f: sum("f"), m, k };
}

function file(n: string, s: number, m = NOW): ScanNode {
  return { n, s, u: s, a: s, f: 1, m, t: 1 };
}

function scanOf(tree: ScanNode): Scan {
  return {
    root: "/",
    scannedAt: NOW,
    tree,
    exts: {},
    topFiles: [],
  };
}

function context(threads: Context["threads"] = new Map()): Context {
  return {
    home: H,
    bbData: `${H}/.bb`,
    threads,
    disk: { total: 1000e9, free: 100e9, used: 900e9, volumes: [] },
    now: NOW,
  };
}

describe("isProtected", () => {
  const ctx = context();
  it.each([
    "/",
    "/Users",
    H,
    `${H}/Library`,
    `${H}/Library/Caches`,
    `${H}/Documents`,
    `${H}/.bb`,
    `${H}/.bb/bb.db`,
    `${H}/.bb/thread-storage`,
    `${H}/.bb/plugins/auto-update/data.db`,
    "/Applications/Utilities",
    "/System/Library/AssetsV2/x",
    "/private/var/folders/ab/cd",
    "/usr/local/bin/node",
    `${H}/.bb/thread-storage/`,
    `${H}//.bb/bb.db`,
    `${H}/Projects/../Documents`,
    `${H}/Library/Mobile Documents/com~apple~CloudDocs`,
    `${H}/Library/CloudStorage/GoogleDrive-me`,
    `${H}/Library/Keychains/ABCD/keychain-2.db`,
  ])("keeps %s", (path) => expect(isProtected(path, ctx)).toBe(true));

  it.each([
    `${H}/Library/Caches/pip`,
    `${H}/Documents/old.zip`,
    `${H}/.bb/thread-storage/thr_a`,
    `${H}/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_a-1`,
    "/Applications/Docker.app",
    "/private/tmp/build",
    `${H}/Projects/app/node_modules`,
  ])("allows %s", (path) => expect(isProtected(path, ctx)).toBe(false));
});

describe("BB lists", () => {
  const tree = dir("", [
    dir("Users", [
      dir("me", [
        dir(".bb", [
          dir("thread-storage", [
            dir("thr_live", [file("run.pt", 5e9)]),
            dir("thr_old", [file("data.jsonl", 3e9)]),
            dir("thr_gone", [file("x.bin", 1e9)]),
          ]),
          dir("plugins", [
            dir("environment-git-worktree", [
              dir("host-data", [
                dir("worktrees", [
                  dir("thr_live-1", [file("a", 2e9)]),
                  dir("thr_old-1", [file("b", 4e9)]),
                ]),
              ]),
            ]),
          ]),
        ]),
        dir("Projects", [
          dir("app", [
            dir(".claude", [
              dir("worktrees", [
                dir("agent-old", [file("c", 1e9)], NOW - 5 * DAY),
                dir("agent-new", [file("d", 1e9)]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);
  const threads = new Map([
    ["thr_live", { title: "Live", project: "p", archivedAt: null }],
    [
      "thr_old",
      { title: "Old", project: "p", archivedAt: (NOW - 10 * DAY) * 1000 },
    ],
  ]);
  const items = bbItems(scanOf(tree), context(threads));

  it("files thread storage by its thread", () => {
    expect(items.live.map((i) => i.name)).toEqual(["Live"]);
    expect(items.archived.map((i) => i.name)).toEqual(["Old", "thr_gone"]);
    expect(items.archived[1].meta).toBe("deleted thread");
  });

  it("skips a worktree a live thread works in, and one BB is tearing down", () => {
    const shared = bbItems(scanOf(tree), {
      ...context(threads),
      inUse: [
        `${H}/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_old-1/repo`,
      ],
    });
    expect(shared.worktrees.map((i) => i.name)).toEqual(["agent-old"]);
    const fresh = new Map(threads);
    fresh.set("thr_old", {
      title: "Old",
      project: "p",
      archivedAt: (NOW - 60) * 1000,
    });
    expect(
      bbItems(scanOf(tree), context(fresh)).worktrees.map((i) => i.name),
    ).toEqual(["agent-old"]);
  });

  it("lists worktrees without a live thread, and idle Claude Code worktrees", () => {
    expect(items.worktrees.map((i) => i.path)).toEqual([
      `${H}/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_old-1`,
      `${H}/Projects/app/.claude/worktrees/agent-old`,
    ]);
  });
});

describe("snapshot", () => {
  it("splits the disk into groups that add up", () => {
    const tree = dir("", [
      dir("Applications", [dir("Big.app", [file("bin", 2e9)])]),
      dir("Users", [
        dir("me", [
          dir(".cache", [dir("uv", [file("wheel", 3e9)])]),
          dir("Projects", [
            dir("app", [
              dir("node_modules", [file("pkg", 1e9)]),
              file("main.ts", 1e6),
            ]),
          ]),
          dir(".bb", [dir("thread-storage", [dir("thr_a", [file("x", 4e9)])])]),
        ]),
      ]),
    ]);
    const scan = scanOf(tree);
    const ctx = context();
    assignGroups(scan, ctx);
    const snap = snapshot(scan, ctx, {
      scanning: false,
      error: null,
      fullDiskAccess: true,
    });
    const bytes = Object.fromEntries(snap.groups.map((g) => [g.id, g.bytes]));
    expect(bytes.apps).toBe(2e9);
    expect(bytes.dev).toBe(4e9);
    expect(bytes.bb).toBe(4e9);
    expect(bytes.files).toBe(1e6);
    expect(snap.dev.find((c) => c.id === "uv")).toMatchObject({
      size: 3e9,
      inClean: true,
      path: `${H}/.cache/uv`,
    });
    expect(snap.dev.find((c) => c.id === "nodeModules")).toMatchObject({
      size: 1e9,
      count: 1,
      inClean: false,
    });
    expect(snap.apps.map((a) => a.name)).toEqual(["Big"]);
  });

  it("asks for Full Disk Access only when the scan ran without it", () => {
    const status = { scanning: false, error: null, fullDiskAccess: false };
    const unreadable = (scan: Scan) =>
      snapshot(scan, context(), status).system.find(
        (i) => i.name === "Not readable",
      )?.meta;
    const scan = scanOf(dir("", [file("a", 1e9)]));
    expect(unreadable(scan)).toMatch(/needs Full Disk Access/);
    expect(unreadable({ ...scan, fullDiskAccess: true })).toMatch(
      /only macOS reads them/,
    );
  });
});

describe("removeFromTree", () => {
  it("takes the bytes off every parent", () => {
    const scan = scanOf(
      dir("", [dir("a", [dir("b", [file("c", 5), file("d", 7)])])]),
    );
    removeFromTree(scan, "/a/b/c");
    expect(find(scan.tree, "/a/b/c")).toBeNull();
    expect(find(scan.tree, "/a")?.s).toBe(7);
    expect(scan.tree.s).toBe(7);
  });

  it("drops the deleted files from Largest files", () => {
    const scan = scanOf(
      dir("", [dir("a", [file("big", 9), file("other", 8)])]),
    );
    scan.topFiles = [
      [9, 9, 9, "/a/big", NOW],
      [8, 8, 8, "/a/other", NOW],
    ];
    removeFromTree(scan, "/a/big");
    expect(scan.topFiles.map((f) => f[3])).toEqual(["/a/other"]);
  });
});
