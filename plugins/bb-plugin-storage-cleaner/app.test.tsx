import { expect, it } from "vitest";
import { loadPluginApp } from "@get-bb/plugin-sdk/testing/app";

it("shows on its settings page and as a page Customize rail can add", async () => {
  const app = await loadPluginApp(() => import("./app"));
  expect(app.settingsSections.map((s) => [s.id, s.title])).toEqual([
    ["storage", "Storage"],
  ]);
  expect(app.navPanels.map((p) => [p.id, p.path, p.icon])).toEqual([
    ["storage", "storage", "Clean"],
  ]);
});
