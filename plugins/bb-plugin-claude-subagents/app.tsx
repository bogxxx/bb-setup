import { definePluginApp, experimental_THREAD_INFO_SECTION_GROUPS } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { SubagentsBannerDetails, SubagentsBannerSummary, SubagentsCardSection, useSubagentsBannerVisible } from "./src/ui/InChatSubagents";
import { SubagentsTab } from "./src/ui/SubagentsTab";

export default definePluginApp((app) => {
  app.slots.experimental_threadContextCardSection({
    id: "subagents",
    title: "Subagents",
    group: experimental_THREAD_INFO_SECTION_GROUPS.related,
    order: 40,
    component: SubagentsCardSection,
  });

  app.slots.experimental_threadContextSegment({
    id: "subagents",
    title: "Subagents",
    group: "2_subagents",
    summary: SubagentsBannerSummary,
    details: SubagentsBannerDetails,
    useVisible: useSubagentsBannerVisible,
  });

  app.slots.experimental_tab({
    context: { kind: "thread" },
    availability: "action",
    id: "subagents",
    title: "Subagents",
    icon: "UserRound",
    layout: "flush",
    component: SubagentsTab,
  });

  app.slots.experimental_threadAction({
    id: "open-subagents",
    title: "Subagents",
    icon: "UserRound",
    group: "claude-subagents",
    item: ({ thread, navigate, experimental_panel }) => {
      const open = () =>
        experimental_panel.openTab({
          tab: { id: "subagents", context: { kind: "thread" }, availability: "action" },
        });
      return {
        label: "Subagents",
        icon: "UserRound",
        run: () => {
          if (open()) return;
          navigate.toThread(thread.id);
          setTimeout(() => {
            if (!open()) toast("Open the thread, then choose Subagents.");
          }, 0);
        },
      };
    },
  });
});
