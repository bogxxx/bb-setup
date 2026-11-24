// The deletions. Each one updates the scan tree in place, so the page shows the
// new sizes without a rescan. Paths are the scan's; every file system and git
// call gets the OS's own spelling through the context's path map.
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  bbItems,
  cacheFolders,
  canonical,
  clearFolded,
  DAY,
  find,
  isProtected,
  joinPath,
  paths,
  removeFromTree,
  type Context,
  type Scan,
} from "./model";
import type { Outcome } from "./shared";

const run = promisify(execFile);

const native = (ctx: Pick<Context, "pathMap">, path: string) =>
  ctx.pathMap ? ctx.pathMap.toNative(path) : path;

/** An absolute path as git writes it: /home/me/repo, or C:/Users/me/repo. */
const absolute = (path: string) =>
  path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/** Git worktrees inside a folder: [repository, worktree] from `.git` files. */
async function worktreesIn(dir: string, depth = 3) {
  const found: [string, string][] = [];
  const walk = async (at: string, left: number) => {
    const entries = await readdir(at, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(at, entry.name);
      if (entry.name === ".git" && entry.isFile()) {
        const text = await readFile(path, "utf8").catch(() => "");
        const gitdir = (/^gitdir:\s*(.+)$/m.exec(text)?.[1].trim() ?? "")
          .replaceAll("\\", "/");
        // Only absolute links to a repository's own worktree list.
        if (absolute(gitdir) && gitdir.includes("/.git/worktrees/")) {
          found.push([gitdir.split("/.git/worktrees/")[0], at]);
        }
      } else if (
        entry.isDirectory() &&
        left > 0 &&
        entry.name !== "node_modules" &&
        entry.name !== ".git"
      ) {
        await walk(path, left - 1);
      }
    }
  };
  await walk(dir, depth);
  return found;
}

/** Delete a file or folder, by its OS path; git forgets each worktree in it. */
export async function removePath(path: string) {
  for (const [repo, worktree] of await worktreesIn(path)) {
    await run("git", [
      "-C",
      repo,
      "worktree",
      "remove",
      "--force",
      "--force",
      worktree,
    ]).catch(() => undefined);
  }
  await rm(path, { recursive: true, force: true, maxRetries: 2 });
}

async function attempt(
  path: string,
  frees: number,
  scan: Scan,
  outcome: Outcome,
  ctx: Pick<Context, "pathMap">,
) {
  try {
    await removePath(native(ctx, path));
    removeFromTree(scan, path);
    outcome.freed += frees;
  } catch {
    outcome.failed.push(path);
  }
}

/** The explorer's and lists' Delete: only scanned, unprotected paths. */
export async function deletePaths(
  list: string[],
  scan: Scan,
  ctx: Context,
): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  for (const raw of list) {
    const path = canonical(raw);
    const node = path && find(scan.tree, path);
    if (!path || !node || isProtected(path, ctx)) outcome.failed.push(raw);
    else await attempt(path, node.u, scan, outcome, ctx);
  }
  return outcome;
}

/** Whether a worktree has no uncommitted changes. */
async function committed(path: string) {
  try {
    const { stdout } = await run("git", ["-C", path, "status", "--porcelain"]);
    return stdout.trim() === "";
  } catch {
    return false;
  }
}

/**
 * Storage of archived threads, and worktrees without a live thread. With
 * `staleDays`, only threads archived at least that long ago.
 */
export async function cleanBb(
  scan: Scan,
  ctx: Context,
  what: { threads: boolean; worktrees: boolean; staleDays?: number },
): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  const { archived, worktrees } = bbItems(scan, ctx);
  const cutoff =
    what.staleDays === undefined
      ? Infinity
      : (ctx.now - what.staleDays * DAY) * 1000;
  /** BB's folders go only when their thread is archived or surely deleted. */
  const gone = async (path: string) => {
    const id = (path.split("/").pop() ?? "").replace(/-\d+$/, "");
    if (ctx.threads.has(id)) return true;
    return ctx.exists ? !(await ctx.exists(id)) : false;
  };
  if (what.threads) {
    for (const item of archived) {
      const archivedAt =
        ctx.threads.get(item.path.split("/").pop() ?? "")?.archivedAt ?? 0;
      if (archivedAt <= cutoff && (await gone(item.path)))
        await attempt(item.path, item.frees, scan, outcome, ctx);
    }
  }
  if (what.worktrees) {
    for (const item of worktrees) {
      const name = item.path.split("/").pop() ?? "";
      // BB's own worktrees lose uncommitted changes; Claude Code's go only clean.
      const ok = name.startsWith("thr_")
        ? await gone(item.path)
        : await committed(native(ctx, item.path));
      if (ok) await attempt(item.path, item.frees, scan, outcome, ctx);
    }
  }
  return outcome;
}

/**
 * Whether a folder is a build git ignores, inside a repository that is a
 * project, not the home folder itself.
 */
async function ignoredBuild(path: string, ctx: Context) {
  const dir = native(ctx, path.slice(0, path.lastIndexOf("/")) || "/");
  try {
    const { stdout } = await run("git", [
      "-C",
      dir,
      "rev-parse",
      "--show-toplevel",
    ]);
    // Git prints C:/Users/me/repo on Windows; compare in the scan's spelling.
    const raw = stdout.trim();
    const top = ctx.pathMap ? ctx.pathMap.toScan(raw) : raw;
    if (!top) return false;
    const real = await realpath(native(ctx, ctx.home)).catch(() => null);
    const homes = [ctx.home];
    const realHome = real && (ctx.pathMap ? ctx.pathMap.toScan(real) : real);
    if (realHome) homes.push(realHome);
    const fold = (p: string) =>
      ctx.platform === "win32" ? p.toLowerCase() : p;
    if (!homes.some((h) => fold(top).startsWith(`${fold(h)}/`))) return false;
    await run("git", ["-C", dir, "check-ignore", "-q", native(ctx, path)]);
    return true;
  } catch {
    return false;
  }
}

/** A real folder, not a link to one somewhere else. */
async function isFolder(path: string) {
  return lstat(path).then(
    (s) => s.isDirectory() && !s.isSymbolicLink(),
    () => false,
  );
}

/**
 * Empty the caches in Clean, and delete git-ignored build folders. With
 * `staleDays`, only what nothing touched for that long; an unknown time counts
 * as recent.
 */
export async function cleanDev(
  scan: Scan,
  ctx: Context,
  staleDays?: number,
): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  const old = (mtime: number) =>
    staleDays === undefined ||
    (mtime > 0 && ctx.now - mtime >= staleDays * DAY);
  for (const { kind, folders } of cacheFolders(scan, ctx)) {
    if (!kind.inClean) continue;
    for (const { path, node } of folders) {
      if (!(await isFolder(native(ctx, path)))) continue;
      if (kind.id === "build") {
        if (old(node.m) && (await ignoredBuild(path, ctx)))
          await attempt(path, node.u, scan, outcome, ctx);
        continue;
      }
      // A cache folder stays; what is inside it goes.
      const entries = await readdir(native(ctx, path)).catch(
        () => [] as string[],
      );
      const scanned = new Map((node.k ?? []).map((c) => [c.n, c]));
      for (const name of entries) {
        const child = scanned.get(name);
        const at = joinPath(path, name);
        const mtime =
          child?.m ??
          (await lstat(native(ctx, at)).then(
            (s) => s.mtimeMs / 1000,
            () => 0,
          ));
        if (!old(mtime)) continue;
        if (child) await attempt(at, child.u, scan, outcome, ctx);
        else
          await rm(native(ctx, at), { recursive: true, force: true }).catch(
            () => outcome.failed.push(at),
          );
      }
      if (staleDays === undefined) {
        outcome.freed += node.o?.[1] ?? 0;
        clearFolded(scan, path);
      }
    }
  }
  return outcome;
}

/** Empty the Trash, the way each OS keeps it. */
export async function cleanTrash(scan: Scan, ctx: Context): Promise<Outcome> {
  if (ctx.platform === "linux") return cleanLinuxTrash(scan, ctx);
  if (ctx.platform === "win32") return cleanRecycleBin(scan, ctx);
  return cleanMacTrash(scan, ctx);
}

/** macOS: directly with Full Disk Access, else through Finder. */
async function cleanMacTrash(scan: Scan, ctx: Context): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  const dir = paths(ctx).trash;
  const node = find(scan.tree, dir);
  const before = node && !node.x ? node.u : 0;
  try {
    for (const name of await readdir(dir))
      await attempt(joinPath(dir, name), 0, scan, outcome, ctx);
    outcome.freed = outcome.failed.length ? 0 : before;
    clearFolded(scan, dir);
  } catch {
    await run("osascript", [
      "-e",
      'tell application "Finder" to empty trash',
    ]).catch(() => outcome.failed.push(dir));
  }
  return outcome;
}

/**
 * Linux, after the freedesktop.org Trash: what is inside its files, info and
 * expunged folders goes; the folders stay, as file managers expect them.
 */
async function cleanLinuxTrash(scan: Scan, ctx: Context): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  const dir = paths(ctx).trash;
  const node = find(scan.tree, dir);
  const before = node && !node.x ? node.u : 0;
  for (const sub of ["files", "info", "expunged"]) {
    const at = joinPath(dir, sub);
    const names = await readdir(native(ctx, at)).catch(() => [] as string[]);
    for (const name of names)
      await attempt(joinPath(at, name), 0, scan, outcome, ctx);
    clearFolded(scan, at);
  }
  outcome.freed = outcome.failed.length ? 0 : before;
  return outcome;
}

/**
 * Windows: Clear-RecycleBin empties this user's Recycle Bin on every drive.
 * Then the scan forgets what was in the user's own folder of it.
 */
async function cleanRecycleBin(scan: Scan, ctx: Context): Promise<Outcome> {
  const outcome: Outcome = { freed: 0, failed: [] };
  const dir = paths(ctx).trash;
  const node = find(scan.tree, dir);
  const before = node && !node.x ? node.u : 0;
  try {
    await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        // An empty bin makes Clear-RecycleBin fail on some Windows releases.
        "Clear-RecycleBin -Force -ErrorAction SilentlyContinue; exit 0",
      ],
      { windowsHide: true, timeout: 10 * 60_000 },
    );
  } catch {
    outcome.failed.push(dir);
    return outcome;
  }
  for (const own of node?.k ?? []) {
    if (own.t || own.x) continue;
    const at = joinPath(dir, own.n);
    for (const child of [...(own.k ?? [])]) removeFromTree(scan, joinPath(at, child.n));
    clearFolded(scan, at);
  }
  outcome.freed = before;
  return outcome;
}
