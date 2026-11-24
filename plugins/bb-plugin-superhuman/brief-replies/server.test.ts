import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, { BRIEF_REPLIES_INSTRUCTIONS } from "./server";

it("adds its instructions only while the switch is on", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "superhuman" });
  const settings = bb.settings.define({
    briefReplies: { type: "boolean", label: "Brief Replies", default: false },
  });
  await plugin(bb, settings);
  const instructions = () =>
    harness.inspection.registrations.instructionProvider?.({
      threadId: "thr_a",
      projectId: "proj_a",
    });

  expect(instructions()).toBeNull();
  await harness.behavior.setSettings({ briefReplies: true });
  expect(instructions()).toBe(BRIEF_REPLIES_INSTRUCTIONS);
  await harness.behavior.setSettings({ briefReplies: false });
  expect(instructions()).toBeNull();
});
