import { memo, useEffect, useMemo } from "react";
import {
  useSdk,
  useSettings,
  useBbContext,
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  type PluginAppBuilder,
  type PluginThreadActionTarget,
} from "@get-bb/plugin-sdk/app";
import { start, update } from "./controller";
import { openSnooze } from "../snooze/app";
import "./app.css";

/**
 * E runs BB's own Archive, with its confirmation, pane cleanup and Undo. Memo:
 * the bridge redraws on every sidebar change, this only when the thread does.
 */
const ThreadActions = memo(function ThreadActions({
  thread,
}: {
  thread: PluginThreadActionTarget;
}) {
  const [archive] = experimental_useThreadActions(thread, {
    keys: ["bb--core/archive"],
  });
  const run = archive?.action.run;
  useEffect(() => {
    update({
      threadActions: {
        snooze: () => openSnooze(thread.id),
        archive: () => {
          if (!run) return false;
          void run();
          return true;
        },
      },
    });
    return () => update({ threadActions: undefined });
  }, [thread.id, run]);
  return null;
});

/** The open thread as thread menus see it, while the sidebar lists it. */
function useOpenThread(): PluginThreadActionTarget | null {
  const { threadId } = useBbContext();
  const { threads } = experimental_useSidebarThreads();
  const thread = threads.find((candidate) => candidate.id === threadId);
  return useMemo(
    () =>
      thread
        ? {
            id: thread.id,
            projectId: thread.projectId,
            parentThreadId: thread.parentThreadId,
            archivedAt: thread.archivedAt,
            pinnedAt: thread.pinnedAt,
            sectionId: thread.sectionId,
            isUnread: thread.isUnread,
            status: thread.status,
            environment: null,
          }
        : null,
    [thread],
  );
}

// Settings and keybindings reach the page script through this React bridge.
function Bridge() {
  const sdk = useSdk();
  const { values } = useSettings();
  const thread = useOpenThread();
  useEffect(() => update({ settings: values ?? {} }), [values]);
  useEffect(() => {
    const refresh = () =>
      sdk.system.config().then(
        (config) => update({ bindings: config.keybindings }),
        () => {}, // Keep the last bindings while the connection recovers.
      );
    void refresh();
    const stops = [
      sdk.subscribe({ event: "system:config-changed", callback: refresh }),
      sdk.subscribe({ event: "realtime:connection", callback: refresh }),
    ];
    return () => stops.forEach((stop) => stop());
  }, [sdk]);
  return thread ? <ThreadActions thread={thread} /> : null;
}

export default function registerHotkeys(app: PluginAppBuilder) {
  app.contentScripts.register({ id: "hotkeys", mount: start });
  app.slots.experimental_appOverlay({
    id: "hotkeys-bridge",
    component: Bridge,
  });
}
