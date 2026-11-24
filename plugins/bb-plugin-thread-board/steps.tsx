// Hover steps for a board card, and the small chip the card and the sidebar share.
import { useEffect, useRef, useState, type ReactElement } from "react";
import * as HoverCard from "@radix-ui/react-hover-card";
import { useSdk } from "@get-bb/plugin-sdk/app";
import { latestSteps, type Tag } from "./board";
import { useMediaQuery } from "@/components/ui/hooks/use-media-query";
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";

export function chipClass(tag: Tag): string {
  if (tag === "review") {
    return "bg-gradient-to-r from-orange-500/20 to-amber-400/30 text-amber-800 dark:text-amber-200";
  }
  if (tag === "snoozed" || tag === "pinned") return "bg-muted text-muted-foreground";
  return "bg-orange-500/10 text-orange-600 dark:text-orange-400";
}

export function Chip({ tag }: { tag: Tag }) {
  if (!tag) return null;
  return (
    <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none", chipClass(tag))}>
      {tag}
    </span>
  );
}

type Step = ReturnType<typeof latestSteps>[number];

type CacheEntry = {
  controller: AbortController;
  promise: Promise<Step[]>;
  users: number;
};

const stepCache = new Map<string, CacheEntry>();

function retainSteps(threadId: string, load: (signal: AbortSignal) => Promise<Step[]>) {
  let entry = stepCache.get(threadId);
  if (!entry) {
    const controller = new AbortController();
    entry = { controller, promise: load(controller.signal), users: 0 };
    stepCache.set(threadId, entry);
  }
  const current = entry;
  current.users += 1;
  return {
    promise: current.promise,
    release() {
      current.users -= 1;
      if (current.users <= 0) {
        current.controller.abort();
        if (stepCache.get(threadId) === current) stepCache.delete(threadId);
      }
    },
  };
}

function statusDot(status: string): string {
  if (status === "completed") return "bg-emerald-500";
  if (status === "pending") return "bg-amber-500";
  if (status === "error") return "bg-red-500";
  return "bg-muted-foreground/50";
}

function StepList({ label, steps }: { label: string; steps: Step[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="space-y-1">
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <ul className="space-y-1">
        {steps.map((step, index) => (
          <li key={`${step.actor}-${index}`} className="flex items-start gap-1.5 text-xs text-foreground">
            <span className={cn("mt-1 size-1.5 shrink-0 rounded-full", statusDot(step.status))} />
            <span className="min-w-0 flex-1 truncate">{step.label}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StepsPopover({ threadId, title, tag }: { threadId: string; title: string; tag: Tag }) {
  const sdk = useSdk();
  const sdkRef = useRef(sdk);
  sdkRef.current = sdk;
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let live = true;
    const { promise, release } = retainSteps(threadId, (signal) =>
      sdkRef.current.threads
        .timeline({
          threadId,
          segmentLimit: "2",
          deferContent: "true",
          includeNestedRows: "true",
          signal,
        })
        .then((result) => latestSteps(result.rows)),
    );
    promise.then(
      (next) => {
        if (!live) return;
        setSteps(next);
        setError(false);
      },
      (err: unknown) => {
        if (!live) return;
        if (typeof err === "object" && err !== null && "name" in err && err.name === "AbortError") return;
        setError(true);
      },
    );
    return () => {
      live = false;
      release();
    };
  }, [threadId]);

  const agent = steps?.filter((step) => step.actor === "agent") ?? [];
  const you = steps?.filter((step) => step.actor === "you") ?? [];
  return (
    <div data-board-steps="" className="space-y-2">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</span>
        <Chip tag={tag} />
      </div>
      {error ? (
        <p className="text-xs text-muted-foreground">Couldn't load steps</p>
      ) : steps === null ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-2">
          <StepList label="Agent" steps={agent} />
          <StepList label="You" steps={you} />
        </div>
      )}
    </div>
  );
}

/** Hover steps around a card link. Coarse pointers, which cannot hover, get the link alone. */
export function CardHover({
  threadId,
  title,
  tag,
  children,
}: {
  threadId: string;
  title: string;
  tag: Tag;
  children: ReactElement;
}) {
  const canHover = useMediaQuery("(hover: hover)");
  const portalProps = usePortalScopeProps();
  if (!canHover) return children;
  return (
    <HoverCard.Root openDelay={400}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          {...portalProps}
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={8}
          className="z-50 w-72 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-md outline-none"
        >
          <StepsPopover threadId={threadId} title={title} tag={tag} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
