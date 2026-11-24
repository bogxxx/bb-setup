// @vitest-environment happy-dom
// The page with a fake server: the machine picker, a Windows machine's
// categories, and an offline machine.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { rpcContract } from "./contract";
import { assignGroups, snapshot, type Context, type ScanNode } from "./model";
import type { Machine } from "./shared";

const NOW = Math.floor(Date.now() / 1000);
const dir = (n: string, k: ScanNode[]): ScanNode => ({
  n,
  s: k.reduce((t, c) => t + c.s, 0),
  u: k.reduce((t, c) => t + c.u, 0),
  a: k.reduce((t, c) => t + c.a, 0),
  f: k.reduce((t, c) => t + c.f, 0),
  m: NOW,
  k,
});
const file = (n: string, s: number): ScanNode => ({ n, s, u: s, a: s, f: 1, m: NOW, t: 1 });

function windowsSnapshot() {
  const tree = dir("", [
    dir("Users", [dir("me", [dir("Downloads", [file("big.iso", 6e9)])])]),
    dir("$Recycle.Bin", [dir("S-1-5-21-1", [file("$R1.zip", 8e8)])]),
    dir("Windows", [file("explorer.exe", 9e9)]),
  ]);
  const scan = { root: "/", scannedAt: NOW, tree, exts: {}, topFiles: [], used: tree.s };
  const ctx: Context = {
    platform: "win32",
    drive: "C:",
    home: "/Users/me",
    bbData: "/Users/me/.bb",
    threads: new Map(),
    disk: { total: 100e9, free: 20e9, used: 80e9, volumes: [] },
    now: NOW,
  };
  assignGroups(scan, ctx);
  return snapshot(scan, ctx, { scanning: false, error: null, fullDiskAccess: true });
}

const machines: Machine[] = [
  { id: "host_server", name: "oracle", connected: true, primary: true },
  { id: "host_win", name: "Old VM", connected: true, primary: false },
  { id: "host_off", name: "predator", connected: false, primary: false },
];

// Node's own localStorage global hides the DOM's in tests; use a plain one.
const store = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
  },
});

beforeEach(() => store.clear());
afterEach(() => cleanup());

async function render() {
  const app = await loadPluginApp(() => import("./app"));
  const calls: string[] = [];
  const view = renderSlot<object, typeof rpcContract>(app.settingsSections[0], {}, {
    rpc: {
      storageMachines: () => ({ machines, primaryId: "host_server" }),
      storageSnapshot: ({ hostId }) => {
        calls.push(hostId);
        return hostId === "host_off"
          ? { snapshot: null, error: "predator is offline. Its scan shows when it connects." }
          : { snapshot: windowsSnapshot(), error: null };
      },
      storageFolder: () => null,
      storageRescan: () => null,
      storageOpenFullDiskAccess: () => null,
      storageDelete: () => ({ freed: 0, failed: [] }),
      storageClean: () => ({ freed: 0, failed: [] }),
    },
  });
  return { view, calls };
}

it("starts on the server's machine and lists every machine", async () => {
  const { view, calls } = await render();
  await waitFor(() => expect(calls).toEqual(["host_server"]));
  for (const m of machines) expect(view.getByRole("radio", { name: new RegExp(m.name) })).toBeTruthy();
  expect(view.getByRole("radio", { name: /oracle/ }).getAttribute("aria-checked")).toBe("true");
});

it("words a Windows machine's categories the Windows way", async () => {
  const { view } = await render();
  await waitFor(() => view.getByText("Clean: everything in the Recycle Bin"));
  expect(view.getByText("Windows, page file, unreadable folders")).toBeTruthy();
  expect(view.getByText("Clean: package caches, builds, crash dumps")).toBeTruthy();
  // No Full Disk Access notice outside macOS.
  expect(view.queryByText(/Full Disk Access/)).toBeNull();
});

it("says when the picked machine is offline, and remembers the pick", async () => {
  const { view, calls } = await render();
  await waitFor(() => view.getByText("Clean: everything in the Recycle Bin"));
  fireEvent.click(view.getByRole("radio", { name: /predator/ }));
  await waitFor(() => view.getByText(/predator is offline/));
  expect(calls).toContain("host_off");
  expect(view.queryByText("Clean: everything in the Recycle Bin")).toBeNull();
  expect(window.localStorage.getItem("storage-cleaner:machine")).toBe("host_off");
});
