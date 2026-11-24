import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanBb, cleanDev, deletePaths } from "./clean";
import type { Context, Scan, ScanNode } from "./model";

const NOW = Math.floor(Date.now() / 1000);
let root: string;
let home: string;

/** Writes files under the temp home and returns the matching scan tree. */
function build(files: Record<string, number>): Scan {
  const tree: ScanNode = { n: "", s: 0, u: 0, a: 0, f: 0, m: NOW, k: [] };
  for (const [rel, size] of Object.entries(files)) {
    const path = join(home, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "x");
    let node = tree;
    const parts = path.split("/").filter(Boolean);
    parts.forEach((name, i) => {
      node.s += size;
      node.u += size;
      node.a += size;
      node.f += 1;
      const last = i === parts.length - 1;
      let next = node.k!.find((c) => c.n === name);
      if (!next) {
        next = last
          ? { n: name, s: 0, u: 0, a: 0, f: 0, m: NOW, t: 1 }
          : { n: name, s: 0, u: 0, a: 0, f: 0, m: NOW, k: [] };
        node.k!.push(next);
      }
      node = next;
    });
    node.s = node.u = node.a = size;
    node.f = 1;
  }
  return {
    root: "/",
    scannedAt: NOW,
    tree,
    exts: {},
    topFiles: [],
  };
}

function context(
  threads: Context["threads"] = new Map(),
  exists?: Context["exists"],
): Context {
  return {
    home,
    bbData: join(home, ".bb"),
    threads,
    exists,
    disk: { total: 0, free: 0, used: 0, volumes: [] },
    now: NOW,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "storage-cleaner-test-"));
  home = join(root, "Users", "me");
  mkdirSync(home, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("deletePaths", () => {
  it("deletes scanned paths and refuses protected or unknown ones", async () => {
    const scan = build({
      "Projects/app/dist.zip": 10,
      "Library/Caches/pip/w": 5,
    });
    const outcome = await deletePaths(
      [
        join(home, "Projects/app/dist.zip"),
        join(home, "Library"),
        join(home, "Projects/nope"),
      ],
      scan,
      context(),
    );
    expect(outcome.freed).toBe(10);
    expect(outcome.failed).toEqual([
      join(home, "Library"),
      join(home, "Projects/nope"),
    ]);
    expect(existsSync(join(home, "Projects/app/dist.zip"))).toBe(false);
    expect(existsSync(join(home, "Library/Caches/pip/w"))).toBe(true);
  });
});

describe("cleanBb", () => {
  it("keeps the data of a thread missing from the list that still exists", async () => {
    const scan = build({
      ".bb/thread-storage/thr_kept/a": 1,
      ".bb/thread-storage/thr_gone/b": 2,
      ".bb/thread-storage/thr_old/c": 3,
    });
    const threads = new Map([
      ["thr_old", { title: "Old", project: "", archivedAt: 1 }],
    ]);
    const outcome = await cleanBb(
      scan,
      context(threads, async (id) => id === "thr_kept"),
      { threads: true, worktrees: true },
    );
    expect(outcome.freed).toBe(5);
    expect(existsSync(join(home, ".bb/thread-storage/thr_kept"))).toBe(true);
    expect(existsSync(join(home, ".bb/thread-storage/thr_gone"))).toBe(false);
    expect(existsSync(join(home, ".bb/thread-storage/thr_old"))).toBe(false);
  });

  it("with staleDays, keeps threads archived recently", async () => {
    const scan = build({ ".bb/thread-storage/thr_new/a": 1 });
    const threads = new Map([
      ["thr_new", { title: "New", project: "", archivedAt: Date.now() }],
    ]);
    await cleanBb(scan, context(threads), {
      threads: true,
      worktrees: false,
      staleDays: 7,
    });
    expect(existsSync(join(home, ".bb/thread-storage/thr_new"))).toBe(true);
  });
});

describe("deletePaths paths", () => {
  it("reads a trailing slash as the folder itself", async () => {
    const scan = build({ ".bb/thread-storage/thr_a/x": 1 });
    const outcome = await deletePaths(
      [join(home, ".bb/thread-storage") + "/"],
      scan,
      context(),
    );
    expect(outcome.failed).toHaveLength(1);
    expect(existsSync(join(home, ".bb/thread-storage/thr_a/x"))).toBe(true);
  });
});

describe("Claude Code worktrees", () => {
  it("go only without uncommitted changes", async () => {
    const old = NOW - 5 * 86400;
    const scan = build({
      "Projects/app/.claude/worktrees/clean/a": 1,
      "Projects/app/.claude/worktrees/dirty/b": 1,
    });
    for (const name of ["clean", "dirty"]) {
      const at = join(home, "Projects/app/.claude/worktrees", name);
      execFileSync("git", ["init", "-q", at]);
      execFileSync("git", [
        "-C",
        at,
        "-c",
        "user.email=a@b",
        "-c",
        "user.name=a",
        "add",
        "-A",
      ]);
      execFileSync("git", [
        "-C",
        at,
        "-c",
        "user.email=a@b",
        "-c",
        "user.name=a",
        "commit",
        "-qm",
        "x",
      ]);
    }
    writeFileSync(
      join(home, "Projects/app/.claude/worktrees/dirty/b"),
      "changed",
    );
    const trees = scan.tree.k![0];
    const stamp = (n: ScanNode) => {
      n.m = old;
      n.k?.forEach(stamp);
    };
    stamp(trees);
    await cleanBb(scan, context(), { threads: false, worktrees: true });
    expect(existsSync(join(home, "Projects/app/.claude/worktrees/clean"))).toBe(
      false,
    );
    expect(existsSync(join(home, "Projects/app/.claude/worktrees/dirty"))).toBe(
      true,
    );
  });
});

describe("cleanDev", () => {
  it("leaves builds alone when the home folder itself is the repository", async () => {
    const scan = build({
      "Documents/thesis/build/paper.pdf": 3,
      ".gradle/gradle.properties": 1,
    });
    execFileSync("git", ["init", "-q", home]);
    writeFileSync(join(home, ".gitignore"), "*\n");
    await cleanDev(scan, context());
    expect(existsSync(join(home, "Documents/thesis/build/paper.pdf"))).toBe(
      true,
    );
    expect(existsSync(join(home, ".gradle/gradle.properties"))).toBe(true);
  });

  it("empties caches in place and deletes only git-ignored build folders", async () => {
    const scan = build({
      ".cache/uv/archive/w": 4,
      "Projects/app/build/out.o": 2,
      "Projects/app/.gitignore": 1,
      "Projects/lib/build/keep.sh": 1,
    });
    writeFileSync(join(home, "Projects/app/.gitignore"), "build/\n");
    for (const repo of ["Projects/app", "Projects/lib"])
      execFileSync("git", ["init", "-q", join(home, repo)]);
    const outcome = await cleanDev(scan, context());
    expect(existsSync(join(home, ".cache/uv"))).toBe(true);
    expect(existsSync(join(home, ".cache/uv/archive"))).toBe(false);
    expect(existsSync(join(home, "Projects/app/build"))).toBe(false);
    expect(existsSync(join(home, "Projects/lib/build/keep.sh"))).toBe(true);
    expect(outcome.freed).toBe(6);
  });
});
