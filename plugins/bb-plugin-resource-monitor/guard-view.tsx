// The Resources page's Guard section: what Guard does, its last events, and
// Pause all.
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { useRpc } from "@get-bb/plugin-sdk/app";
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
import { Button } from "./components/ui/button";
import type { rpcContract } from "./contract";
import { count, errorText, plural, usePolling } from "./processes-view";
import type { GuardInfo } from "./shared";

function guardLine({ enabled, running, status }: GuardInfo) {
  if (!enabled) return "Off. Turn it on in Resource Monitor’s settings.";
  if (!running || !status) return "Not running";
  const { mode, counts } = status;
  if (mode === "paused") return `Paused: ${plural(counts.paused)}`;
  if (mode === "overload")
    return `Overload: ${count(counts.background)} on efficiency cores`;
  return "Normal";
}

export function GuardView() {
  const rpc = useRpc<typeof rpcContract>();
  const read = useCallback(() => rpc.call("guardStatus"), [rpc]);
  const { data: info, error, refetch, setData } = usePolling(read);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const setPauseAll = async (paused: boolean) => {
    setBusy(true);
    try {
      setData(await rpc.call("setPauseAll", { paused }));
      refetch(); // Drops a poll sent before the switch.
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setBusy(false);
    }
  };
  // Resume all stays while Guard is stopped, or it pauses all again on start.
  const resume = info?.pauseAll;
  const pause = !resume && info?.enabled && info.running;
  return (
    <section aria-label="Guard" className="mt-8 text-sm">
      {/* As tall as with its button, so the list below holds still. */}
      <div className="flex min-h-7 items-center gap-3 max-md:pointer-coarse:min-h-9">
        <p className="min-w-0 flex-1">
          <span className="font-medium text-foreground">Guard</span>{" "}
          <span className="text-muted-foreground">
            {info && guardLine(info)}
          </span>
        </p>
        {(resume || pause) && (
          <Button
            variant="outline"
            size="sm"
            className="h-7 shrink-0 max-md:pointer-coarse:h-9"
            disabled={busy}
            onClick={() =>
              resume ? void setPauseAll(false) : setConfirming(true)
            }
          >
            {resume ? "Resume all" : "Pause all"}
          </Button>
        )}
      </div>
      <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {info?.status?.events
          .slice(-4)
          .reverse()
          .map((event, index) => (
            <li
              key={index}
              className={event.error ? "text-destructive" : undefined}
            >
              {new Date(event.at).toTimeString().slice(0, 5)} {event.message}
            </li>
          ))}
      </ul>
      {error && <p className="mt-1 text-destructive">{error}</p>}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base leading-none tracking-tight">
              Pause all?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This stops every agent, what it runs, and BB's terminals, also
              ones started later, until you press Resume all.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void setPauseAll(true)}>
              Pause all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
