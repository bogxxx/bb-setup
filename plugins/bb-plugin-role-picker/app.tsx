import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import "./composer-footer.css";

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
    <label className="flex h-6 items-center gap-1.5 text-xs text-muted-foreground">
      <span>Role</span>
      <select
        aria-label="Role"
        className="h-6 max-w-36 rounded-md border border-border bg-background px-1.5 text-xs text-foreground"
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

function composerShell(anchor: HTMLElement): Element | null {
  return anchor.closest("[data-promptbox-shell]") ?? anchor.closest("[data-follow-up-composer]");
}

function directSlot(parent: Element): HTMLElement | null {
  const host = parent.querySelector(":scope > [data-role-picker-slot]");
  return host instanceof HTMLElement ? host : null;
}

function makeSlot(): HTMLDivElement {
  const host = document.createElement("div");
  host.setAttribute("data-role-picker-slot", "");
  host.className = "flex shrink-0 items-center";
  return host;
}

function modelRowFor(anchor: HTMLElement): HTMLElement | null {
  const action = anchor.closest("[data-plugin-composer-action]");
  const modelRow = action?.parentElement?.previousElementSibling;
  if (!(modelRow instanceof HTMLElement) || !modelRow.hasAttribute("data-promptbox-expanded-only")) {
    return null;
  }
  return modelRow;
}

function useRoleSlot() {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    let owned: HTMLElement | null = null;
    let cancelled = false;

    const releaseOwned = () => {
      owned?.remove();
      owned = null;
    };

    const claim = (parent: Element, placeNode: (host: HTMLElement) => void): HTMLElement => {
      const existing = directSlot(parent);
      if (existing) {
        if (owned && owned !== existing) releaseOwned();
        owned = existing;
        placeNode(existing);
        return existing;
      }
      const host = owned ?? makeSlot();
      placeNode(host);
      owned = host;
      return host;
    };

    const place = () => {
      if (cancelled) return;
      const action = anchor.closest("[data-plugin-composer-action]");
      const footer = composerShell(anchor)?.querySelector("[data-follow-up-composer-footer]");
      const cluster = footer?.lastElementChild;
      let host: HTMLElement | null = null;

      if (cluster instanceof HTMLElement) {
        host = claim(cluster, (node) => {
          if (cluster.firstElementChild !== node) cluster.prepend(node);
        });
      } else {
        const modelRow = modelRowFor(anchor);
        if (modelRow) {
          host = claim(modelRow, (node) => {
            if (node.parentElement !== modelRow) modelRow.appendChild(node);
          });
        }
      }

      if (!host) releaseOwned();
      if (action instanceof HTMLElement) action.hidden = host !== null;
      setSlot((current) => (current === host ? current : host));
    };

    place();
    const observer = new MutationObserver(place);
    observer.observe(composerShell(anchor) ?? document.body, { childList: true, subtree: true });
    return () => {
      cancelled = true;
      observer.disconnect();
      releaseOwned();
      const action = anchor.closest("[data-plugin-composer-action]");
      if (action instanceof HTMLElement) action.hidden = false;
    };
  }, []);

  return { anchorRef, slot };
}

function ComposerRole() {
  const composer = useComposer();
  const { anchorRef, slot } = useRoleSlot();
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
