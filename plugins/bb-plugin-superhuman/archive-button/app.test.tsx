// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen } from "@testing-library/react";
import type { PluginSidebarThread } from "@get-bb/plugin-sdk/app";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { asPluginApp } from "../testing";

afterEach(cleanup);

const listed = { id: "t1", projectId: "p1" } as PluginSidebarThread;

async function render(settings: Record<string, boolean> = {}, threads = [listed]) {
  const app = await loadPluginApp(asPluginApp(() => import("./app")));
  const run = vi.fn(async () => {});
  renderSlot(
    app.threadHeaderActions[0]!,
    { threadId: "t1", projectId: "p1", isCompactViewport: false },
    {
      settings,
      sidebarThreads: { status: "ready", threads },
      threadActions: (thread) => [
        {
          key: "bb--core/archive",
          pluginId: "bb--core",
          group: "4_lifecycle",
          action: { label: "Archive", icon: "Archive", run },
        },
        {
          key: "bb--core/delete",
          pluginId: "bb--core",
          group: "4_lifecycle",
          action: { label: `Delete ${thread.id}`, icon: "Trash", run: vi.fn() },
        },
      ],
    },
  );
  return run;
}

it("archives the thread through BB's own Archive", async () => {
  const run = await render();
  fireEvent.click(screen.getByRole("button", { name: "Archive thread" }));
  expect(run).toHaveBeenCalledOnce();
});

it("shows nothing with the setting off, or for a thread the sidebar doesn't list", async () => {
  await render({ archiveButton: false });
  expect(screen.queryByRole("button")).toBeNull();
  cleanup();
  await render({}, []);
  expect(screen.queryByRole("button")).toBeNull();
});
