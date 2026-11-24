import { execFileSync } from "node:child_process";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { Scan, ScanNode } from "./model";
import { SCANNER_PY } from "./scanner";
import { SCANNER_JS } from "./scanner-node";

let dir: string;
let root: string;

const MB = 1024 * 1024;
const child = (node: ScanNode, name: string) =>
  node.k?.find((c) => c.n === name);

function scanWithNode(): Scan {
  const script = join(dir, "scan.mjs");
  const out = join(dir, "node.json");
  writeFileSync(script, SCANNER_JS);
  execFileSync(process.execPath, [
    script,
    root,
    out,
    JSON.stringify({ devs: [statSync(root).dev], windows: false }),
  ]);
  return JSON.parse(readFileSync(out, "utf8")) as Scan;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "storage-scanner-"));
  root = join(dir, "root");
  mkdirSync(join(root, "a/b"), { recursive: true });
  mkdirSync(join(root, "small"), { recursive: true });
  mkdirSync(join(root, "links"), { recursive: true });
  writeFileSync(join(root, "a/big.bin"), Buffer.alloc(3 * MB, 1));
  writeFileSync(join(root, "a/b/mid.dat"), Buffer.alloc(2 * MB, 1));
  for (let i = 0; i < 20; i++) writeFileSync(join(root, `small/f${i}.txt`), "hi");
  writeFileSync(join(root, "links/one.bin"), Buffer.alloc(4 * MB, 1));
  linkSync(join(root, "links/one.bin"), join(root, "links/two.bin"));
  symlinkSync("../a", join(root, "links/to-a"));
  mkdirSync(join(root, "locked"));
  writeFileSync(join(root, "locked/secret"), "x");
  chmodSync(join(root, "locked"), 0o000);
});

afterAll(() => {
  chmodSync(join(root, "locked"), 0o755);
  rmSync(dir, { recursive: true, force: true });
});

it("writes the macOS scanner's tree for Linux", () => {
  const scan = scanWithNode();
  expect(scan.root).toBe("/");
  expect(scan.tree.n).toBe("");
  const a = child(scan.tree, "a")!;
  expect(child(a, "big.bin")?.t).toBe(1);
  expect(child(a, "big.bin")?.a).toBeGreaterThanOrEqual(3 * MB);
  expect(child(child(a, "b")!, "mid.dat")?.a).toBeGreaterThanOrEqual(2 * MB);
  // Folders under 1 MB fold into their parent's small items.
  expect(child(scan.tree, "small")).toBeUndefined();
  expect(scan.tree.o?.[3]).toBeGreaterThanOrEqual(20);
  expect(scan.exts.txt[1]).toBe(20);
  expect(scan.exts["@link"][1]).toBe(1);
});

it("splits hard links and frees nothing for sure while another link stays", () => {
  const links = child(scanWithNode().tree, "links")!;
  const one = child(links, "one.bin")!;
  const two = child(links, "two.bin")!;
  expect(one.a + two.a).toBeGreaterThanOrEqual(4 * MB);
  expect(one.a).toBe(two.a);
  expect(one.u + two.u).toBe(0);
});

it("marks a folder it can't read", () => {
  // root reads everything, so only a user sees the lock.
  if (process.getuid?.() === 0) return;
  const locked = scanWithNode().tree.k?.find((c) => c.n === "locked");
  // A small unreadable folder is kept, so the page can say so.
  expect(locked?.x).toBe(1);
});

it("matches the Python scanner on a tree without hard links", () => {
  let python = true;
  try {
    execFileSync("python3", ["--version"]);
  } catch {
    python = false;
  }
  if (!python) return;
  rmSync(join(root, "links"), { recursive: true, force: true });
  chmodSync(join(root, "locked"), 0o755);
  try {
    const node = scanWithNode();
    writeFileSync(join(dir, "scan.py"), SCANNER_PY);
    execFileSync("python3", [join(dir, "scan.py"), root, join(dir, "py.json")]);
    const py = JSON.parse(readFileSync(join(dir, "py.json"), "utf8")) as Scan;
    expect(node.tree).toEqual(py.tree);
    expect(node.exts).toEqual(py.exts);
  } finally {
    chmodSync(join(root, "locked"), 0o000);
  }
});
