import { useSyncExternalStore } from "react";
import {
  useBbContext,
  useBbNavigate,
  useSettings,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "../components/ui/icon";
import { PHONE } from "./layout";

function usePhone() {
  return useSyncExternalStore(
    (change) => {
      const phone = window.matchMedia(PHONE);
      phone.addEventListener("change", change);
      return () => phone.removeEventListener("change", change);
    },
    () => window.matchMedia(PHONE).matches,
  );
}

/**
 * On a phone, the thread's bar starts a new thread as the sidebar's New thread
 * does, in the thread's project. The button's group, left empty elsewhere,
 * takes no room: see snooze/app.css.
 */
export function NewThreadButton(_: PluginThreadHeaderActionProps) {
  const { values } = useSettings();
  const { projectId } = useBbContext();
  const navigate = useBbNavigate();
  const phone = usePhone();
  if (values?.phoneLayout === false || !phone) return null;
  return (
    <button
      type="button"
      aria-label="New thread"
      title="New thread"
      onClick={() =>
        navigate.toCompose({
          ...(projectId ? { projectId } : {}),
          focusPrompt: true,
        })
      }
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--subtle-foreground)] transition-colors duration-150 hover:bg-[var(--state-hover)] hover:text-muted-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9"
    >
      {/* The sidebar's own icon for New thread. */}
      <Icon
        name="MessageSquarePlus"
        className="size-4 max-md:pointer-coarse:size-5"
        aria-hidden
      />
    </button>
  );
}
