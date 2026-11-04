import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";

type Role = "regular" | "orchestrator";

function threadIdOf(scope: { kind: string; threadId?: string }): string | null {
  if (scope.kind === "thread" || scope.kind === "queued-message") {
    return typeof scope.threadId === "string" ? scope.threadId : null;
  }
  return null;
}

function RoleSelect({ threadId }: { threadId: string | null }) {
  const rpc = useRpc<typeof rpcContract>();
  const [role, setRole] = useState<Role>("regular");

  const load = useCallback(() => {
    rpc.call("get_role", { threadId }).then(
      (result) => setRole(result.role),
      () => setRole("regular"),
    );
  }, [rpc, threadId]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <label className="flex h-7 items-center gap-1.5 text-xs text-muted-foreground">
      <span>Role</span>
      <select
        aria-label="Role"
        className="h-7 max-w-36 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
        value={role}
        onChange={(event) => {
          const next = event.target.value === "orchestrator" ? "orchestrator" : "regular";
          const previous = role;
          setRole(next);
          rpc.call("set_role", { threadId, role: next }).catch(() => setRole(previous));
        }}
      >
        <option value="regular">Regular</option>
        <option value="orchestrator">Orchestrator</option>
      </select>
    </label>
  );
}

function useSlotBesideModelPicker() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const place = () => {
      const action = anchor.closest("[data-plugin-composer-action]");
      const voiceRow = action?.parentElement;
      const modelRow = voiceRow?.previousElementSibling;
      if (!(action instanceof HTMLElement) || !(modelRow instanceof HTMLElement) || !modelRow.hasAttribute("data-promptbox-expanded-only")) {
        if (action instanceof HTMLElement) action.hidden = false;
        setSlot((current) => (current === null ? current : null));
        return;
      }

      let host = modelRow.querySelector(":scope > [data-role-picker-slot]");
      if (!(host instanceof HTMLElement)) {
        host = document.createElement("div");
        host.setAttribute("data-role-picker-slot", "");
        host.className = "flex shrink-0 items-center";
        modelRow.appendChild(host);
      }

      action.hidden = true;
      setSlot((current) => (current === host ? current : host));
    };

    place();
    const shell = anchor.closest("[data-promptbox-shell]") ?? document.body;
    const observer = new MutationObserver(place);
    observer.observe(shell, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return { anchorRef, slot };
}

function ComposerRole() {
  const composer = useComposer();
  const { anchorRef, slot } = useSlotBesideModelPicker();
  const control = <RoleSelect threadId={threadIdOf(composer.scope)} />;
  return (
    <>
      <span ref={anchorRef} data-role-picker-anchor="" className="sr-only" />
      {slot ? createPortal(control, slot) : control}
    </>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "role",
    actions: [{ id: "role", component: ComposerRole }],
  });
});
