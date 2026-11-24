// The Resources page's process list: sort, filter, and quit, like Activity
// Monitor.
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { z } from "zod";
import { experimental_Icon as Icon, useRpc } from "@get-bb/plugin-sdk/app";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Button, buttonVariants } from "./components/ui/button";
import { cn } from "./lib/utils";
import type { ProcessInfo, rpcContract } from "./contract";

const POLL_MS = 2000;
const LISTED = 8;

type SortKey = "name" | "pid" | "cpuPercent" | "memoryBytes";
type Sort = { key: SortKey; descending: boolean };
type Target = Pick<ProcessInfo, "pid" | "name" | "command">;
type Outcome = z.infer<typeof rpcContract.quitProcesses.output>;

const collator = new Intl.Collator(undefined, { numeric: true });

/** Processes whose name, command, or PID contains the query, ignoring case. */
export function filterProcesses(processes: ProcessInfo[], query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle) return processes;
  return processes.filter(
    (p) =>
      p.name.toLowerCase().includes(needle) ||
      p.command.toLowerCase().includes(needle) ||
      String(p.pid).includes(needle),
  );
}

/** A sorted copy; ties keep PID order, so rows hold still between readings. */
export function sortProcesses(processes: ProcessInfo[], sort: Sort) {
  const { key, descending } = sort;
  return [...processes].sort((a, b) => {
    const order =
      key === "name" ? collator.compare(a.name, b.name) : a[key] - b[key];
    return (descending ? -order : order) || a.pid - b.pid;
  });
}

/** A first click sorts names A→Z and numbers high→low; a second flips it. */
export function nextSort(sort: Sort, key: SortKey): Sort {
  return sort.key === key
    ? { key, descending: !sort.descending }
    : { key, descending: key !== "name" };
}

export const formatCpu = (percent: number) => percent.toFixed(1);

export function formatMemory(bytes: number) {
  const kb = Math.round(bytes / 1024);
  const mb = Math.round(bytes / 1024 ** 2);
  if (kb < 1024) return `${kb} KB`;
  if (mb < 1024) return `${mb} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

export const count = (n: number) => n.toLocaleString("en-US");

export const plural = (n: number) =>
  `${count(n)} ${n === 1 ? "process" : "processes"}`;

/** "Quit 2 processes; 1 couldn’t be quit: Not permitted". */
export function quitMessage({ quit, failed }: Outcome) {
  if (!failed.length) return `Quit ${plural(quit)}`;
  const reasons = [...new Set(failed.map((f) => f.reason))].join(", ");
  if (!quit) return `Couldn’t quit ${plural(failed.length)}: ${reasons}`;
  return `Quit ${plural(quit)}; ${failed.length} couldn’t be quit: ${reasons}`;
}

export const errorText = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** What `read` answers, every 2 s while the page shows; `refetch` reads now. */
export function usePolling<T>(read: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let stopped = false;
    const load = async () => {
      clearTimeout(timer);
      if (busy || stopped || document.hidden) return;
      busy = true;
      try {
        const next = await read();
        if (stopped) return;
        setData(next);
        setError(null);
      } catch (cause) {
        if (!stopped) setError(errorText(cause));
      } finally {
        busy = false;
      }
      if (!stopped) timer = setTimeout(load, POLL_MS);
    };
    const resume = () => void load();
    void load();
    document.addEventListener("visibilitychange", resume);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [read, nonce]);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, refetch, setData };
}

function useProcesses(hostId: string) {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(
    () => rpc.call("listProcesses", { hostId }),
    [rpc, hostId],
  );
  const { data: processes, error, refetch } = usePolling(read);
  return { processes, error, refetch };
}

/** One machine's processes; remount it with a key to switch machines. */
export function ProcessesView({ hostId }: { hostId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const { processes, error, refetch } = useProcesses(hostId);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>({
    key: "cpuPercent",
    descending: true,
  });
  const [targets, setTargets] = useState<Target[]>([]);
  const [confirming, setConfirming] = useState(false);
  const visible = useMemo(
    () => sortProcesses(filterProcesses(processes ?? [], query), sort),
    [processes, query, sort],
  );
  const matching = useMemo(
    () => (query.trim() ? visible.filter((p) => !p.protected) : []),
    [visible, query],
  );
  const ask = useCallback((next: Target[]) => {
    setTargets(next);
    setConfirming(true);
  }, []);
  const quit = async (force: boolean) => {
    // A second click while the dialog fades out must not signal again.
    if (!confirming) return;
    try {
      const outcome = await rpc.call("quitProcesses", {
        hostId,
        pids: targets.map((t) => t.pid),
        force,
      });
      const message = quitMessage(outcome);
      if (outcome.failed.length) toast.error(message);
      else toast.success(message);
    } catch (cause) {
      toast.error(errorText(cause));
    }
    refetch();
  };
  const header = (key: SortKey, label: string, className?: string) => (
    <SortHeader
      label={label}
      active={sort.key === key}
      descending={sort.descending}
      numeric={key !== "name"}
      className={className}
      onClick={() => setSort(nextSort(sort, key))}
    />
  );
  return (
    <section className="@container mt-8 text-sm">
      <div className="flex items-center gap-2">
        <label className="relative min-w-0 max-w-64 flex-1">
          <Icon
            name="Search"
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter processes"
            aria-label="Filter processes"
            className="h-7 w-full rounded-md border border-border bg-transparent pl-7 pr-2 text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none max-md:pointer-coarse:text-base [&::-webkit-search-cancel-button]:hidden"
          />
        </label>
        {matching.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0"
            onClick={() => ask(matching)}
          >
            Quit {matching.length} matching
          </Button>
        )}
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {processes &&
            (query.trim()
              ? `${count(visible.length)} of ${count(processes.length)}`
              : plural(processes.length))}
        </span>
      </div>
      {error && <p className="mt-2 text-destructive">{error}</p>}
      <table className="mt-2 w-full table-fixed border-separate border-spacing-0">
        <thead className="sticky top-0 z-10 bg-background">
          <tr>
            {header("name", "Name")}
            {header("pid", "PID", "w-16 @max-md:hidden")}
            {header("cpuPercent", "CPU %", "w-16")}
            {header("memoryBytes", "Memory", "w-20")}
            <th className="w-9 border-b border-border">
              <span className="sr-only">Quit</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {visible.map((p) => (
            <ProcessRow
              key={p.pid}
              pid={p.pid}
              name={p.name}
              command={p.command}
              cpu={formatCpu(p.cpuPercent)}
              memory={formatMemory(p.memoryBytes)}
              quittable={!p.protected}
              onQuit={ask}
            />
          ))}
        </tbody>
      </table>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <QuitDialog targets={targets} onQuit={quit} />
      </AlertDialog>
    </section>
  );
}

function SortHeader({
  label,
  active,
  descending,
  numeric,
  className,
  onClick,
}: {
  label: string;
  active: boolean;
  descending: boolean;
  numeric: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <th
      aria-sort={active ? (descending ? "descending" : "ascending") : undefined}
      className={cn(
        "h-8 whitespace-nowrap border-b border-border px-2 font-normal",
        numeric ? "text-right" : "text-left",
        className,
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "relative cursor-pointer text-xs hover:text-foreground",
          active ? "font-medium text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
        {/* Beside the label, not in the flow, so it never widens the cell. */}
        {active && (
          <Icon
            name={descending ? "ChevronDown" : "ChevronUp"}
            className={cn(
              "absolute top-1/2 size-3 -translate-y-1/2",
              numeric ? "right-full mr-0.5" : "left-full ml-0.5",
            )}
          />
        )}
      </button>
    </th>
  );
}

/** Takes strings, not the process, so unchanged rows skip each reading. */
const ProcessRow = memo(function ProcessRow({
  pid,
  name,
  command,
  cpu,
  memory,
  quittable,
  onQuit,
}: Target & {
  cpu: string;
  memory: string;
  quittable: boolean;
  onQuit: (targets: Target[]) => void;
}) {
  return (
    <tr className="group hover:bg-state-hover">
      <td className="h-8 truncate px-2 text-foreground" title={command}>
        {name}
      </td>
      <td className="px-2 text-right tabular-nums text-muted-foreground @max-md:hidden">
        {pid}
      </td>
      <td className="px-2 text-right tabular-nums">{cpu}</td>
      <td className="px-2 text-right tabular-nums">{memory}</td>
      <td className="pl-1 text-right">
        {quittable && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Quit ${name} (${pid})`}
            className="size-7 align-middle text-muted-foreground opacity-0 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100"
            onClick={() => onQuit([{ pid, name, command }])}
          >
            <Icon name="CircleX" />
          </Button>
        )}
      </td>
    </tr>
  );
});

function QuitDialog({
  targets,
  onQuit,
}: {
  targets: Target[];
  onQuit: (force: boolean) => void;
}) {
  const one = targets.length === 1 ? targets[0] : null;
  const more = targets.length - LISTED;
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle className="text-base leading-none tracking-tight">
          {one ? `Quit “${one.name}”?` : `Quit ${targets.length} processes?`}
        </AlertDialogTitle>
        <AlertDialogDescription asChild>
          {one ? (
            <div className="space-y-2">
              <p>PID {one.pid}</p>
              <p className="break-all font-mono text-xs">{one.command}</p>
            </div>
          ) : (
            <ul className="space-y-0.5">
              {targets.slice(0, LISTED).map((t) => (
                <li key={t.pid} className="truncate">
                  {t.name} <span className="tabular-nums">({t.pid})</span>
                </li>
              ))}
              {more > 0 && <li>and {more} more</li>}
            </ul>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          className={cn(
            buttonVariants({ variant: "destructive" }),
            "mt-2 sm:mt-0",
          )}
          onClick={() => onQuit(true)}
        >
          Force Quit
        </AlertDialogAction>
        <AlertDialogAction onClick={() => onQuit(false)}>
          Quit
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}
