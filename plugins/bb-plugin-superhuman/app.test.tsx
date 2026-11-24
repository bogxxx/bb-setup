// @vitest-environment jsdom
import { expect, it } from "vitest";
import {
  loadPluginApp,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";

/** The test runtime collects commands, though its type doesn't list them. */
function commands(app: CapturedPluginApp) {
  type Command = { id: string };
  return (app as CapturedPluginApp & { commandPaletteActions: Command[] })
    .commandPaletteActions;
}

it("registers every feature under an id of its own", async () => {
  const app = await loadPluginApp(() => import("./app"));
  const ids = (registrations: { id: string }[]) =>
    registrations.map(({ id }) => id);
  const registered = {
    contentScripts: ids(app.contentScripts),
    threadActions: ids(app.threadActions),
    threadHeaderActions: ids(app.threadHeaderActions),
    appOverlays: ids(app.appOverlays),
    commands: ids(commands(app)),
  };
  expect(registered).toEqual({
    contentScripts: ["hotkeys", "ui-polish", "ui-polish-inline-vis"],
    threadActions: ["snooze"],
    threadHeaderActions: ["snooze-moon", "archive", "new-thread"],
    appOverlays: [
      "hotkeys-bridge",
      "universal-search",
      "snooze-dialogs",
      "search-actions",
      "ui-polish-switch",
      "phone-layout",
      "title-bar-switch",
      "dismiss-cards",
    ],
    commands: ["snooze-thread", "show-snoozed-threads"],
  });
  const all = Object.values(registered).flat();
  expect(new Set(all).size).toBe(all.length);
});
