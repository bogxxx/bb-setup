import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  experimental_THREAD_ACTION_GROUPS,
  useBbContext,
  useBbNavigate,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
  useSettings,
  type PluginAppBuilder,
  type PluginThreadHeaderActionProps,
} from "@get-bb/plugin-sdk/app";
import { defaultFilter, useCommandState } from "cmdk";
import { toast } from "sonner";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { useIsCompactViewport } from "../components/ui/hooks/use-compact-viewport";
import { Icon } from "../components/ui/icon";
import { usePortalScopeProps } from "../lib/portal-scope";
import { cn } from "../lib/utils";
import { useSearchAdapter } from "../universal-search/app";
import { layoutFilter } from "../universal-search/layout";
import type { Snooze, rpcContract } from "./server";
import "./app.css";
import { CHANGED_CHANNEL } from "./shared";
import { nextThread, sidebarThreadIds } from "./sidebar";
import { installSnoozedSearch } from "./thread-search";
import {
  fmtUntil,
  fmtWhen,
  lastUsed,
  parse,
  presets,
  type Choice,
} from "./time";

type DialogRequest = { kind: "snooze"; threadId: string } | { kind: "snoozed" };

// Commands and thread menus have no React tree of their own and the header
// button exists only on thread pages, so all of them open the dialogs through
// this store, and an app overlay renders them. The last dialog stays set while
// it animates closed. Each opening gets a new key, since BB's drawer on phones
// keeps its content mounted.
let dialogState = {
  dialog: null as DialogRequest | null,
  open: false,
  key: 0,
};
const dialogListeners = new Set<() => void>();

function setDialogState(next: typeof dialogState) {
  dialogState = next;
  for (const listener of dialogListeners) listener();
}

const openDialog = (dialog: DialogRequest) =>
  setDialogState({ dialog, open: true, key: dialogState.key + 1 });
const closeDialog = () => setDialogState({ ...dialogState, open: false });

function useDialogState() {
  return useSyncExternalStore(
    (listener) => {
      dialogListeners.add(listener);
      return () => dialogListeners.delete(listener);
    },
    () => dialogState,
  );
}

type ToastCardProps = {
  id: string | number;
  tone: "success" | "error";
  title: string;
  description: string;
  onUndo?: () => void;
};

/** The card of BB's own toasts. */
function ToastCard(props: ToastCardProps) {
  const { id, tone, title, description, onUndo } = props;
  return (
    // It renders in BB's toaster, so it sets the plugin's style scope itself.
    <div
      {...usePortalScopeProps()}
      className="w-[var(--width,356px)] max-w-[calc(100vw-32px)] shrink-0 rounded-md border border-border bg-popover px-4 py-3 text-popover-foreground shadow-sm max-[600px]:w-[calc(100vw-32px)]"
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-foreground">
          <Icon
            name={tone === "success" ? "CircleCheck" : "AlertCircle"}
            className="size-4"
            style={{ margin: 0 }}
            aria-hidden
          />
        </div>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-4 whitespace-pre-wrap break-words text-sm font-medium leading-5 [overflow-wrap:anywhere]">
            {title}
          </div>
          <div className="mt-0.5 flex min-w-0 flex-col items-start gap-2 text-xs leading-5 text-muted-foreground">
            <div className="line-clamp-4 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
              {description}
            </div>
            {onUndo && (
              <button
                type="button"
                onClick={() => {
                  onUndo();
                  toast.dismiss(id);
                }}
                className="shrink-0 cursor-pointer rounded-md text-xs font-medium text-muted-foreground underline underline-offset-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                Undo
              </button>
            )}
          </div>
        </div>
        <button
          type="button"
          aria-label="Dismiss notification"
          onClick={() => toast.dismiss(id)}
          className="-mr-1 -mt-1 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-state-hover hover:text-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <Icon
            name="X"
            className="size-3.5"
            style={{ margin: 0 }}
            aria-hidden
          />
        </button>
      </div>
    </div>
  );
}

function showToast(card: Omit<ToastCardProps, "id">) {
  toast.custom((id) => <ToastCard id={id} {...card} />, {
    className: "bb-app-toast",
  });
}

export function showError(title: string, error: unknown) {
  showToast({
    tone: "error",
    title,
    description: error instanceof Error ? error.message : String(error),
  });
}

/** The plugin's glyphs from `bb.branding.experimental_icons`. */
const MOON = "superhuman/moon";
const MOON_FILLED = "superhuman/moon-filled";

/** The snoozes and the last choice, refetched after every server write. */
type SnoozeRpc = ReturnType<typeof useRpc<typeof rpcContract>>;

function useSnoozes() {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<{
    snoozes: Snooze[];
    last: Choice | null;
  }>({ snoozes: [], last: null });
  const latestRequest = useRef(0);

  const refetch = useCallback(() => {
    const request = ++latestRequest.current;
    rpc.call("listSnoozes").then(
      (result) => {
        if (request === latestRequest.current) setState(result);
      },
      () => undefined,
    );
  }, [rpc]);

  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(CHANGED_CHANNEL, refetch);
  const connection = useRealtimeConnectionState();
  const previous = useRef(connection);
  useEffect(() => {
    if (previous.current === "reconnecting" && connection === "connected") {
      refetch();
    }
    previous.current = connection;
  }, [connection, refetch]);
  return { rpc, ...state };
}

/** Whether the Snooze setting is on; it is until the settings load. */
function useSnoozeOn() {
  return useSettings().values?.snooze !== false;
}

// Commands have no React tree; the dialogs' overlay keeps this current.
let snoozeOn = true;

/** What thread menus read: each snoozed thread's wake time, and the way to wake it. */
function useMenuData() {
  const { rpc, snoozes } = useSnoozes();
  const on = useSnoozeOn();
  return useMemo(
    () => ({
      on,
      until: new Map(snoozes.map((row) => [row.threadId, row.until])),
      unsnooze: (threadId: string) => unsnooze(rpc, threadId),
    }),
    [on, rpc, snoozes],
  );
}

/**
 * Adds the threads snoozes hide to BB's thread search, which leaves hidden
 * threads out, while Snooze is on and has any. Returns the anchor to render.
 */
function useSnoozedSearch(rpc: SnoozeRpc, on: boolean, snoozes: Snooze[]) {
  const layouts = useSettings().values?.universalSearch !== false;
  const install = useCallback(
    (disposers: (() => void)[]) => {
      disposers.push(
        installSnoozedSearch(window, layouts, (queries) =>
          rpc
            .call("searchSnoozes", { queries })
            .then(({ results }) => results),
        ),
      );
    },
    [rpc, layouts],
  );
  return useSearchAdapter(on && snoozes.length > 0, install, snoozes);
}

function unsnooze(rpc: SnoozeRpc, threadId: string) {
  rpc
    .call("unsnooze", { threadId })
    .catch((error: unknown) =>
      showError("Could not unsnooze the thread", error),
    );
}

function TimeItem(props: {
  title: string;
  until: number;
  now: number;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={props.title}
      onSelect={props.onSelect}
      className="min-h-8"
    >
      <span className="truncate">{props.title}</span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        {fmtWhen(props.until, props.now)}
      </span>
    </CommandItem>
  );
}

function Picker(props: {
  snoozed: boolean;
  last: Choice | null;
  onSnooze: (until: number, choice: Choice) => void;
  onUnsnooze: () => void;
}) {
  const { snoozed, last, onSnooze, onUnsnooze } = props;
  const [now] = useState(Date.now);
  const [query, setQuery] = useState("");
  const typed = query.trim();

  const presetRows = presets(now);
  const lastUntil = lastUsed(last, now);
  const typedUntil = typed === "" ? null : parse(typed, now);
  const typedRow =
    typedUntil !== null &&
    !presetRows.some(
      (row) => row.until === typedUntil && defaultFilter(row.title, typed) > 0,
    );

  return (
    <>
      <CommandInput
        placeholder="Try: 8 am, 3 days, aug 7"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList
        // While filtering, cmdk sorts the rows by moving them, and it leaves
        // them there when the query is cleared, so the list mounts afresh.
        key={query === "" ? "all" : "filtered"}
      >
        {typedRow ? (
          // cmdk moves ungrouped rows to the end of the list, so this group
          // stays first.
          <CommandGroup forceMount>
            <TimeItem
              title={typed}
              until={typedUntil}
              now={now}
              onSelect={() =>
                onSnooze(typedUntil, { kind: "text", text: typed })
              }
            />
          </CommandGroup>
        ) : (
          <CommandEmpty>No matching times</CommandEmpty>
        )}
        {snoozed && (
          <CommandItem
            value="Unsnooze"
            onSelect={onUnsnooze}
            className="min-h-8"
          >
            Unsnooze
          </CommandItem>
        )}
        {last !== null && lastUntil !== null && (
          <TimeItem
            title="Last used"
            until={lastUntil}
            now={now}
            onSelect={() => onSnooze(lastUntil, last)}
          />
        )}
        {presetRows.map((row) => (
          <TimeItem
            key={row.id}
            title={row.title}
            until={row.until}
            now={now}
            onSelect={() => onSnooze(row.until, { kind: "preset", id: row.id })}
          />
        ))}
      </CommandList>
    </>
  );
}

function SnoozedList(props: {
  snoozes: Snooze[];
  onOpen: (threadId: string) => void;
  onUnsnooze: (threadId: string) => void;
}) {
  const { snoozes, onOpen, onUnsnooze } = props;
  const [now] = useState(Date.now);
  const [query, setQuery] = useState("");
  const compact = useIsCompactViewport();
  const selected = useCommandState((state) => state.value);
  // Like BB's key hints: ⌘ on Apple keyboards, Ctrl elsewhere.
  const modifier = /Mac|iPhone|iPad|iPod/.test(navigator.platform)
    ? "⌘"
    : "Ctrl";
  // cmdk tells rows apart by value, so zero-width spaces keep equal titles apart.
  const rows = snoozes.map((snooze, index) => ({
    ...snooze,
    value: snooze.title.trim() + "​".repeat(index),
  }));

  return (
    <>
      <CommandInput
        placeholder="Search snoozed threads…"
        value={query}
        onValueChange={setQuery}
        onKeyDown={(event) => {
          if (compact || event.key !== "Enter") return;
          if (!event.metaKey && !event.ctrlKey) return;
          event.preventDefault();
          const row = rows.find((candidate) => candidate.value === selected);
          if (row !== undefined) onUnsnooze(row.threadId);
        }}
      />
      <CommandList
        // As in the picker, the list mounts afresh when the query is cleared.
        key={query === "" ? "all" : "filtered"}
      >
        <CommandEmpty>
          {snoozes.length === 0 ? "No snoozed threads" : "No matching threads"}
        </CommandEmpty>
        {rows.map((row) => (
          <CommandItem
            key={row.threadId}
            value={row.value}
            onSelect={() => onOpen(row.threadId)}
            className="group min-h-11"
          >
            <div className="min-w-0 flex-1">
              <div className="truncate text-foreground">{row.title}</div>
              <div className="truncate text-xs leading-4 text-subtle-foreground">
                until {fmtUntil(row.until, now)}
              </div>
            </div>
            <button
              type="button"
              tabIndex={-1}
              // Keeps focus in the search field and the click off the row.
              onMouseDown={(event) => event.preventDefault()}
              onClick={(event) => {
                event.stopPropagation();
                onUnsnooze(row.threadId);
              }}
              className="hidden h-7 shrink-0 items-center gap-1 rounded-sm px-1 text-xs text-subtle-foreground hover:text-foreground md:group-data-[selected=true]:inline-flex"
            >
              <span className="mr-1">Unsnooze</span>
              <kbd className="rounded-sm bg-state-hover/50 px-1.5 py-1 font-sans text-xs leading-none tabular-nums text-subtle-foreground">
                {modifier} ↵
              </kbd>
            </button>
          </CommandItem>
        ))}
      </CommandList>
    </>
  );
}

/** Opens the picker for a thread, unless the Snooze setting is off. */
export function openSnooze(threadId: string): boolean {
  if (!snoozeOn) return false;
  openDialog({ kind: "snooze", threadId });
  return true;
}

/**
 * A dialog that looks like BB's command palette: near the top, with no ✕, and
 * with the palette's classes set from the root, so the vendored `command`
 * component stays as the registry ships it.
 */
function PaletteDialog(props: {
  kind: DialogRequest["kind"];
  title: string;
  children: ReactNode;
}) {
  const { dialog, open, key } = useDialogState();
  const { values } = useSettings();
  return (
    <Dialog
      open={open && dialog?.kind === props.kind}
      onOpenChange={(next) => {
        if (!next) closeDialog();
      }}
    >
      <DialogContent
        hideCloseButton
        aria-describedby={undefined}
        className={cn(
          "top-[12%] max-w-[640px] translate-y-0 gap-0 p-0 shadow-lg sm:rounded-xl",
          // In the drawer on phones, which keeps clear of the home bar itself:
          // close to the handle, and flat, without the palette's shadow.
          "max-md:-mt-3 max-md:pb-2 max-md:shadow-none",
        )}
      >
        <DialogTitle className="sr-only">{props.title}</DialogTitle>
        <Command
          key={key}
          filter={
            values?.universalSearch === false ? defaultFilter : layoutFilter
          }
          className={cn(
            // Its own corners would cover the dialog's rounded border.
            "rounded-[inherit]",
            "bg-background text-foreground",
            "[&_[cmdk-input-wrapper]]:py-1 [&_[cmdk-input-wrapper]_[data-icon-root]]:hidden",
            "[&_[cmdk-input]]:placeholder:font-light [&_[cmdk-input]]:placeholder:text-subtle-foreground [&_[cmdk-input]]:placeholder:opacity-70",
            "[&_[cmdk-list]]:max-h-[min(24rem,50dvh)] [&_[cmdk-list]]:p-1 [&_[cmdk-group]]:p-0",
            "[&_[cmdk-item]]:cursor-pointer [&_[cmdk-item]]:gap-3 [&_[cmdk-item]]:rounded-md [&_[cmdk-item][data-selected=true]]:bg-state-hover [&_[cmdk-item][data-selected=true]]:text-foreground",
            "[&_[cmdk-empty]]:px-3 [&_[cmdk-empty]]:py-4 [&_[cmdk-empty]]:text-muted-foreground",
          )}
        >
          {props.children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

function SnoozeDialogs() {
  const { dialog, open } = useDialogState();
  const { rpc, snoozes, last } = useSnoozes();
  const context = useBbContext();
  const navigate = useBbNavigate();
  const on = useSnoozeOn();
  const anchor = useSnoozedSearch(rpc, on, snoozes);
  useEffect(() => {
    snoozeOn = on;
    if (!on && open) closeDialog();
  }, [on, open]);

  async function snooze(threadId: string, until: number, choice: Choice) {
    closeDialog();
    const wasOpen = context.threadId === threadId;
    // Read the order before the thread leaves the sidebar.
    const order = wasOpen ? sidebarThreadIds() : [];
    try {
      const { title, previous, hidden } = await rpc.call("snooze", {
        threadId,
        until,
        choice,
      });
      if (wasOpen) {
        const next = nextThread(order, threadId, hidden);
        if (next === null) navigate.toCompose();
        else navigate.toThread(next);
      }
      showToast({
        tone: "success",
        title: `Snoozed until ${fmtUntil(until, Date.now())}`,
        description: title,
        onUndo: () => {
          const undo =
            previous === null
              ? rpc.call("unsnooze", { threadId })
              : rpc.call("snooze", { threadId, until: previous, choice: null });
          undo.then(
            () => {
              if (wasOpen) navigate.toThread(threadId);
            },
            (error: unknown) => showError("Could not undo the snooze", error),
          );
        },
      });
    } catch (error) {
      showError("Could not snooze the thread", error);
    }
  }

  return (
    <>
      <span ref={anchor} hidden aria-hidden="true" />
      <PaletteDialog kind="snooze" title="Snooze thread">
        {dialog?.kind === "snooze" && (
          <Picker
            snoozed={snoozes.some((row) => row.threadId === dialog.threadId)}
            last={last}
            onSnooze={(until, choice) =>
              void snooze(dialog.threadId, until, choice)
            }
            onUnsnooze={() => {
              closeDialog();
              unsnooze(rpc, dialog.threadId);
            }}
          />
        )}
      </PaletteDialog>
      <PaletteDialog kind="snoozed" title="Snoozed threads">
        <SnoozedList
          snoozes={snoozes}
          onOpen={(threadId) => {
            closeDialog();
            navigate.toThread(threadId);
          }}
          onUnsnooze={(threadId) => unsnooze(rpc, threadId)}
        />
      </PaletteDialog>
    </>
  );
}

function MoonButton({ threadId }: PluginThreadHeaderActionProps) {
  const { snoozes } = useSnoozes();
  const on = useSnoozeOn();
  if (!on) return null;
  const until = snoozes.find((row) => row.threadId === threadId)?.until;
  const label =
    until === undefined
      ? "Snooze thread"
      : `Snoozed until ${fmtUntil(until, Date.now())}`;
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => openDialog({ kind: "snooze", threadId })}
      className="inline-flex size-7 cursor-pointer items-center justify-center rounded-md text-[color:var(--subtle-foreground)] transition-colors duration-150 hover:bg-[var(--state-hover)] hover:text-muted-foreground hover:duration-0 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:size-9"
    >
      <Icon
        name={until === undefined ? MOON : MOON_FILLED}
        className="size-4 max-md:pointer-coarse:size-5"
        aria-hidden
      />
    </button>
  );
}

export default function registerSnooze(app: PluginAppBuilder) {
  // In every thread menu, before Archive; a row shows it as a button once the
  // user adds it in Customize row actions.
  app.slots.experimental_threadAction({
    id: "snooze",
    title: "Snooze",
    icon: MOON,
    group: experimental_THREAD_ACTION_GROUPS.lifecycle,
    order: 10,
    useData: useMenuData,
    item: ({ thread, data }) => {
      if (!data.on || thread.archivedAt !== null) return null;
      const until = data.until.get(thread.id);
      if (until === undefined) {
        return {
          label: "Snooze",
          icon: MOON,
          run: () => openDialog({ kind: "snooze", threadId: thread.id }),
        };
      }
      return {
        label: "Unsnooze",
        detail: `Until ${fmtUntil(until, Date.now())}`,
        icon: MOON_FILLED,
        run: () => data.unsnooze(thread.id),
      };
    },
  });

  app.slots.experimental_threadHeaderAction({
    id: "snooze-moon",
    title: "Snooze thread",
    component: MoonButton,
  });

  app.slots.experimental_appOverlay({
    id: "snooze-dialogs",
    component: SnoozeDialogs,
  });

  app.commands.register({
    id: "snooze-thread",
    title: "Snooze thread",
    isAvailable: ({ threadId }) => snoozeOn && threadId !== null,
    run: ({ threadId }) => {
      if (threadId !== null) openDialog({ kind: "snooze", threadId });
    },
  });

  app.commands.register({
    id: "show-snoozed-threads",
    title: "Show snoozed threads",
    isAvailable: () => snoozeOn,
    run: () => openDialog({ kind: "snoozed" }),
  });
}
