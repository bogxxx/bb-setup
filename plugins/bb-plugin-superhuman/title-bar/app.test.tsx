// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { asPluginApp } from "../testing";

afterEach(cleanup);

const marked = () =>
  document.documentElement.hasAttribute("data-superhuman-no-title-bar");

it("marks the page for app.css only while Hide Title Bar is on", async () => {
  const app = await loadPluginApp(asPluginApp(() => import("./app")));
  renderSlot(app.appOverlays[0]!, {}, { settings: {} });
  expect(marked()).toBe(false);
  cleanup();
  renderSlot(app.appOverlays[0]!, {}, { settings: { hideTitleBar: true } });
  expect(marked()).toBe(true);
  cleanup();
  expect(marked()).toBe(false);
});
