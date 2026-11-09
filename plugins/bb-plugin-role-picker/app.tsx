import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { definePluginApp, useComposer, useRpc, type PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { Button } from "./components/ui/button";
import { QuestionForm } from "./components/ui/question-form";
import type { Question } from "./components/ui/question-form-state";
import type { Role, rpcContract } from "./server";
import "./composer-footer.css";

// The rendererId bb roles ask passes to bb.ui.requestInput (ASK_RENDERER_ID in lib/ask.ts).
const ASK_RENDERER_ID = "ask";

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: "regular", label: "Regular" },
  { value: "orchestrator", label: "Orchestrator" },
  { value: "interviewer", label: "Prompt generator" },
];

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
          const next = ROLE_OPTIONS.find((option) => option.value === event.target.value)?.value ?? "regular";
          const previous = role;
          setRole(next);
          rpc.call("set_role", { threadId, role: next }).catch(() => setRole(previous));
        }}
      >
        {ROLE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
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
  const actionRow = anchor.closest("[data-promptbox-action-row]");
  const modelRow = actionRow?.querySelector(":scope > [data-promptbox-expanded-only]");
  return modelRow instanceof HTMLElement ? modelRow : null;
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
      if (existing && existing !== owned) {
        releaseOwned();
        placeNode(existing);
        return existing;
      }
      const host = existing ?? owned ?? makeSlot();
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

function questionsOf(payload: unknown): Question[] | null {
  const questions = payload && typeof payload === "object" ? (payload as { questions?: unknown }).questions : undefined;
  return Array.isArray(questions) && questions.length > 0 ? (questions as Question[]) : null;
}

// The question card bb roles ask opens: the same form as the builtin AskUserQuestion card.
function AskInteraction({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const questions = useMemo(() => questionsOf(interaction.payload), [interaction.payload]);
  const [busy, setBusy] = useState(false);
  if (!questions) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">This question could not be displayed.</p>
        <Button type="button" variant="outline" onClick={() => void cancel().catch(() => {})}>
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <QuestionForm
      key={interaction.id}
      draftKey={`${interaction.threadId}:${interaction.id}`}
      questions={questions}
      disabled={busy}
      cancelDisabled={busy}
      onSubmit={(answers) => {
        setBusy(true);
        return submit({ answers }).finally(() => setBusy(false));
      }}
      onCancel={cancel}
    />
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "role",
    actions: [{ id: "role", component: ComposerRole }],
  });
  app.slots.pendingInteraction({ id: ASK_RENDERER_ID, component: AskInteraction });
});
