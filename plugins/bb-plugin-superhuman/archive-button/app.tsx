import { useMemo } from "react";
import {
  experimental_useSidebarThreads,
  experimental_useThreadActions,
  useSettings,
  type PluginAppBuilder,
  type PluginThreadActionTarget,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../components/ui/icon";

/** The thread as thread menus see it, while the sidebar lists it. */
function useListedThread(threadId: string): PluginThreadActionTarget | null {
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

/**
 * BB's own Archive, as in the thread's menu: with its confirmation for a
 * thread with children, its pane cleanup, and its Undo.
 */
function Archive({ thread }: { thread: PluginThreadActionTarget }) {
  const [archive] = experimental_useThreadActions(thread, {
    keys: ["bb--core/archive"],
  });
  if (!archive) return null;
  const { label, icon, run } = archive.action;
  return (
    <button
      type="button"
      aria-label={`${label} thread`}
      title={`${label} thread`}
      onClick={() => void run()}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--subtle-foreground)] transition-colors duration-150 hover:bg-[var(--state-hover)] hover:text-muted-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9"
    >
      <Icon
        name={icon}
        className="size-4 max-md:pointer-coarse:size-5"
        aria-hidden
      />
    </button>
  );
}

function ArchiveButton({ threadId }: PluginThreadHeaderActionProps) {
  const { values } = useSettings();
  const thread = useListedThread(threadId);
  if (values?.archiveButton === false || !thread) return null;
  return <Archive thread={thread} />;
}

export default function registerArchiveButton(app: PluginAppBuilder) {
  // Registered after Snooze's moon and before Mobile Layout's New thread, so
  // a phone's bar, which runs from its end, reads New thread, Archive, Snooze.
  app.slots.experimental_threadHeaderAction({
    id: "archive",
    title: "Archive thread",
    component: ArchiveButton,
  });
}
