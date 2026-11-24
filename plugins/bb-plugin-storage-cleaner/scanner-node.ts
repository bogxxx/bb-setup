// The disk scanner for Linux and Windows, which the host entry runs as its own
// Node process at low priority. It writes the same tree as the macOS scanner
// in scanner.ts, with every path spelled the scan's way: on Windows the drive
// is "/", so C:\Users\me is /Users/me.
//
// Usage: node scan.mjs <root> <out.json> <config.json>, where the config is
// { devs: number[], windows: boolean }: the devices of the file systems to
// enter, and whether paths use backslashes.
//
// Sizes: `a` is the space a file takes (its blocks on Linux; Node can't read
// that on Windows, so its length there), split across its hard links; `u` is
// what deleting it frees for sure, nothing while another link keeps the data;
// `s` is its share, `a`.
export const SCANNER_JS = String.raw`
import { lstat, readdir, writeFile } from "node:fs/promises";

const KEEP = 1024 * 1024;
const MAX_KIDS = 300;
const TOP_FILES = 400;
const BIG_FILE = 50 * 1024 * 1024;
/** Folders listed at once, and files stat-ed at once in each. */
const PARALLEL = 16;
const BATCH = 64;

const [root, out, configText] = process.argv.slice(2);
const config = JSON.parse(configText);
const devs = new Set(config.devs.map(String));
const SEP = config.windows ? "\\" : "/";

let active = 0;
const waiting = [];
/** Runs a task in one of PARALLEL slots, so the scan's memory stays bounded. */
async function limit(task) {
  while (active >= PARALLEL) await new Promise((resolve) => waiting.push(resolve));
  active++;
  try {
    return await task();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/** A folder's names and their lstat, null for one that vanished or can't be read. */
async function list(native) {
  const names = await readdir(native);
  const stats = new Array(names.length);
  for (let i = 0; i < names.length; i += BATCH) {
    const got = await Promise.all(
      names.slice(i, i + BATCH).map((nm) => lstat(nativeChild(native, nm)).catch(() => null)),
    );
    for (let j = 0; j < got.length; j++) stats[i + j] = got[j];
  }
  return [names, stats];
}

const nativeChild = (dir, name) => (dir.endsWith(SEP) ? dir + name : dir + SEP + name);
const scanChild = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name);

function extOf(name) {
  const i = name.lastIndexOf(".");
  return i <= 0 || name.length - i > 12 ? "" : name.slice(i + 1).toLowerCase();
}

const exts = new Map();
const top = [];

async function walk(native, at, name) {
  const node = { n: name, s: 0, u: 0, a: 0, f: 0, m: 0, k: [] };
  let names, stats;
  try {
    [names, stats] = await limit(() => list(native));
  } catch {
    node.x = 1;
    return node;
  }
  let kids = [];
  let fs = 0, fu = 0, fa = 0, ff = 0, m = 0;
  const dirs = [];
  for (let i = 0; i < names.length; i++) {
    const st = stats[i];
    if (!st) continue;
    const nm = names[i];
    if (st.isDirectory()) {
      // Other volumes and mounts are their own disks.
      if (devs.has(String(st.dev))) dirs.push(nm);
      continue;
    }
    const alloc = !config.windows && typeof st.blocks === "number" ? st.blocks * 512 : st.size;
    const links = st.isFile() && st.nlink > 1 ? st.nlink : 1;
    const a = Math.floor(alloc / links);
    const u = links > 1 ? 0 : alloc;
    const s = a;
    const mtime = Math.floor(st.mtimeMs / 1000);
    if (mtime > m) m = mtime;
    const x = st.isFile() ? extOf(nm) : st.isSymbolicLink() ? "@link" : "@other";
    const rec = exts.get(x);
    if (rec) {
      rec[0] += s;
      rec[1] += 1;
    } else exts.set(x, [s, 1]);
    if (a >= BIG_FILE) top.push([a, s, u, scanChild(at, nm), mtime]);
    if (a >= KEEP) kids.push({ n: nm, s, u, a, f: 1, m: mtime, t: 1 });
    else {
      fs += s; fu += u; fa += a; ff += 1;
    }
  }
  // Let the listing go before the subfolders load theirs.
  names = stats = null;
  const children = await Promise.all(
    dirs.map((nm) => walk(nativeChild(native, nm), scanChild(at, nm), nm)),
  );
  for (const child of children) {
    if (child.s >= KEEP || child.a >= KEEP || child.x) kids.push(child);
    else {
      fs += child.s; fu += child.u; fa += child.a; ff += child.f;
      if (child.m > m) m = child.m;
    }
  }
  kids.sort((p, q) => q.a - p.a);
  if (kids.length > MAX_KIDS) {
    for (const c of kids.slice(MAX_KIDS)) {
      fs += c.s; fu += c.u; fa += c.a; ff += c.f;
      if (c.m > m) m = c.m;
    }
    kids = kids.slice(0, MAX_KIDS);
  }
  node.s = fs; node.u = fu; node.a = fa; node.f = ff;
  for (const c of kids) {
    node.s += c.s; node.u += c.u; node.a += c.a; node.f += c.f;
    if (c.m > m) m = c.m;
  }
  node.m = m;
  if (ff) node.o = [fs, fu, fa, ff];
  kids.sort((p, q) => q.s - p.s);
  node.k = kids;
  return node;
}

const tree = await walk(root, "/", "");
const topFiles = top
  .sort((p, q) => q[0] - p[0] || q[1] - p[1])
  .slice(0, TOP_FILES);
await writeFile(
  out,
  JSON.stringify({
    root: "/",
    scannedAt: Math.floor(Date.now() / 1000),
    tree,
    exts: Object.fromEntries(exts),
    topFiles,
  }),
);
`;
