import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  definePluginApp,
  useRealtime,
  useRealtimeConnectionState,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import "./app.css";
import { Button } from "./components/ui/button";
import type { rpcContract } from "./contract";
import { GuardView } from "./guard-view";
import { ago, LoadColumns, MachineRow, MeterBars } from "./meter";
import { ProcessesView } from "./processes-view";
import {
  busiest,
  machinesSchema,
  SAMPLE_CHANNEL,
  type MachineSample,
} from "./shared";

const ICON_NAME = "resource-monitor/meter";
/** Windows renew their watch this often, under the server's 30 s. */
const WATCH_EVERY_MS = 15_000;
const PICKED = "resource-monitor:machine";

// Host-drawn icons get no plugin context, so SDK hooks throw inside them.
// MachineFeed has that context; it fills this store, and the icon reads it.
let latest: MachineSample[] | null = null;
// Kept through a dropped connection, so Pause all stays when it matters most.
let guardSupported = false;
const listeners = new Set<() => void>();

function setLatest(machines: MachineSample[] | null) {
  latest = machines;
  const server = machines?.find((m) => m.primary);
  if (server?.sample) guardSupported = server.sample.guard === true;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const useMachines = () => useSyncExternalStore(subscribe, () => latest);
const useGuardSupported = () =>
  useSyncExternalStore(subscribe, () => guardSupported);

/**
 * Renders nothing: reads the machines once, passes each published update to
 * the store, and tells the server a window is watching while it shows.
 */
function MachineFeed() {
  const rpc = useRpc<typeof rpcContract>();
  const connection = useRealtimeConnectionState();
  // Without a connection the last samples go stale; show none instead.
  useEffect(() => {
    if (connection !== "connected") setLatest(null);
  }, [connection]);
  useEffect(() => {
    if (connection !== "connected") return;
    let stopped = false;
    // A published update may come first; the read only fills an empty store.
    rpc.call("machines", null).then(
      (next) => !stopped && latest === null && setLatest(next.machines),
      () => {},
    );
    const watch = () => {
      if (!document.hidden) void rpc.call("watch", null).catch(() => {});
    };
    watch();
    const timer = setInterval(watch, WATCH_EVERY_MS);
    document.addEventListener("visibilitychange", watch);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", watch);
    };
  }, [rpc, connection]);
  useRealtime(SAMPLE_CHANNEL, (payload) => {
    const parsed = machinesSchema.safeParse(payload);
    if (parsed.success) setLatest(parsed.data.machines);
  });
  return null;
}

/** The rail tile's box while the mouse rests on it, else null. */
function useRailHover(icon: RefObject<SVGSVGElement | null>) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  useEffect(() => {
    const tile = icon.current?.closest("[data-nav-rail-item]");
    if (!(tile instanceof HTMLElement)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const show = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.buttons !== 0) return;
      clearTimeout(timer);
      timer = setTimeout(() => setAnchor(tile.getBoundingClientRect()), 150);
    };
    // Also on pointerdown, so the card doesn't hang over the page it opens.
    const hide = () => {
      clearTimeout(timer);
      setAnchor(null);
    };
    // BB's own tooltip opens on pointermove; the card replaces it.
    const muteTooltip = (event: PointerEvent) => {
      if (event.buttons === 0) event.stopPropagation();
    };
    tile.addEventListener("pointerenter", show);
    tile.addEventListener("pointerleave", hide);
    tile.addEventListener("pointerdown", hide);
    tile.addEventListener("pointermove", muteTooltip, true);
    return () => {
      hide();
      tile.removeEventListener("pointerenter", show);
      tile.removeEventListener("pointerleave", hide);
      tile.removeEventListener("pointerdown", hide);
      tile.removeEventListener("pointermove", muteTooltip, true);
    };
  }, [icon]);
  return anchor;
}

const shortName = (m: MachineSample) => m.name.split(".")[0];

/** The hover card: CPU, RAM, GPU for each machine, offline ones last. */
export function MachineRows({ machines }: { machines: MachineSample[] }) {
  return (
    <>
      <div className="rm-card-head" aria-hidden>
        <span />
        <span>CPU</span>
        <span>RAM</span>
        <span>GPU</span>
      </div>
      {machines.map((m) => (
        <MachineRow
          key={m.id}
          name={shortName(m)}
          sample={m.sample}
          note={
            !m.connected
              ? `offline · ${ago(m.lastSeenAt)}`
              : m.sample
                ? undefined
                : m.error
                  ? "no answer"
                  : "reading…"
          }
        />
      ))}
    </>
  );
}

function HoverCard({ anchor }: { anchor: DOMRect }) {
  const machines = useMachines();
  const card = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState(anchor.top);
  // Center the card on the tile, inside the window.
  useLayoutEffect(() => {
    const height = card.current?.offsetHeight ?? 0;
    const centered = anchor.top + (anchor.height - height) / 2;
    setTop(Math.max(8, Math.min(centered, innerHeight - height - 8)));
  }, [anchor, machines?.length]);
  return createPortal(
    <div
      ref={card}
      className="rm-card"
      data-rows=""
      style={{ left: anchor.right + 10, top }}
      role="tooltip"
    >
      {machines?.length ? (
        <MachineRows machines={machines} />
      ) : (
        <LoadColumns sample={null} />
      )}
    </div>,
    document.body,
  );
}

/**
 * The sidebar icon: each bar at the busiest connected machine's load, so any
 * machine near its limit shows; the card says which.
 */
function RailIcon({ className }: { className?: string }) {
  const machines = useMachines();
  const icon = useRef<SVGSVGElement>(null);
  const anchor = useRailHover(icon);
  return (
    <>
      <svg ref={icon} viewBox="0 0 16 16" className={className} fill="currentColor">
        <MeterBars sample={busiest(machines ?? [])} />
      </svg>
      {anchor && <HoverCard anchor={anchor} />}
    </>
  );
}

function MachineCard({ machine }: { machine: MachineSample }) {
  const { sample } = machine;
  const offline = !machine.connected;
  return (
    <section className="rm-machine" data-offline={offline ? "" : undefined}>
      <div className="rm-machine-head">
        <span className="rm-machine-name">{machine.name}</span>
        {machine.primary && <span className="rm-tag">server</span>}
        <span className="rm-detail">
          {offline
            ? `Offline · last seen ${ago(machine.lastSeenAt)}`
            : sample
              ? `${sample.hostname.split(".")[0]} · up ${uptime(sample.uptimeSeconds)}${
                  machine.error ? " · not answering" : ""
                }`
              : machine.error
                ? `Not answering: ${machine.error}`
                : "Reading…"}
        </span>
      </div>
      {!offline && (
        <div className="rm-columns">
          <LoadColumns sample={sample} details />
        </div>
      )}
    </section>
  );
}

function remembered() {
  try {
    return window.localStorage.getItem(PICKED);
  } catch {
    return null;
  }
}

function ResourcesPage() {
  const machines = useMachines();
  // Older servers send no `guard`; Guard needs BB's app on macOS.
  const guard = useGuardSupported();
  const connected = (machines ?? []).filter((m) => m.connected);
  const [picked, setPicked] = useState<string | null>(remembered);
  const shown =
    connected.find((m) => m.id === picked) ??
    connected.find((m) => m.primary) ??
    connected[0];
  const pick = (id: string) => {
    setPicked(id);
    try {
      window.localStorage.setItem(PICKED, id);
    } catch {
      // The pick lasts while the page shows.
    }
  };
  return (
    <div className="rm-page">
      <div>
        <div className="rm-machines">
          {(machines ?? []).map((m) => (
            <MachineCard key={m.id} machine={m} />
          ))}
        </div>
        {guard && <GuardView />}
        {shown && (
          <>
            <div className="rm-picker" role="radiogroup" aria-label="Processes of">
              <span className="rm-picker-label">Processes on</span>
              {connected.map((m) => (
                <Button
                  key={m.id}
                  variant={m.id === shown.id ? "outline" : "ghost"}
                  size="sm"
                  role="radio"
                  aria-checked={m.id === shown.id}
                  onClick={() => pick(m.id)}
                >
                  {m.name}
                </Button>
              ))}
            </div>
            {/* Another machine's list starts fresh: its own sort and filter. */}
            <ProcessesView key={shown.id} hostId={shown.id} />
          </>
        )}
      </div>
    </div>
  );
}

function uptime(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: ICON_NAME, component: RailIcon });
  app.slots.experimental_appOverlay({ id: "sampleFeed", component: MachineFeed });
  app.slots.navPanel({
    id: "resources",
    title: "Resources",
    icon: ICON_NAME,
    path: "resources",
    component: ResourcesPage,
  });
});
