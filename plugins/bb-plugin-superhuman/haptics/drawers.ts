const PAGE = 'main[data-sidebar="inset"]';
// The page's attributes for the sidebar and the right panel, and their values
// while open: the panel opens as a shelf beside the page or over all of it.
const DRAWERS = ["sidebarShelf", "panelShelf"] as const;
const ATTRIBUTES = ["data-sidebar-shelf", "data-panel-shelf"];
const OPEN = new Set(["open", "shelf", "full"]);

type Drawer = (typeof DRAWERS)[number];

/** BB's phone app hands the page its native haptics through this bridge. */
interface NativeBridge {
  capabilities?: readonly string[];
  post?: (message: unknown) => void;
}

/** One light tap: BB's app plays it natively, a browser vibrates if it can. */
export function tap(win: Window): void {
  const native = (win as Window & { bb?: { native?: NativeBridge } }).bb?.native;
  if (native?.capabilities?.includes("haptic") && native.post) {
    native.post({ type: "haptic", kind: "impact-light" });
    return;
  }
  win.navigator.vibrate?.(10);
}

/**
 * Taps whenever the phone's sidebar or right panel opens or closes, until the
 * returned function runs.
 */
export function startDrawerHaptics(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};

  // Where a drawer is headed; wider screens have no shelves, and the panel has
  // none while the sidebar is open. A swipe keeps a drawer marked open while
  // the finger moves, and on release BB slides the page to 0px well before it
  // marks a closed drawer, so the page's offset tells first.
  const headed = (drawer: Drawer): boolean | null => {
    const page = doc.querySelector<HTMLElement>(PAGE);
    const shelf = page?.dataset[drawer];
    if (!page || !shelf) return null;
    return OPEN.has(shelf) && page.style.translate !== "0px";
  };

  const open = {
    sidebarShelf: headed("sidebarShelf"),
    panelShelf: headed("panelShelf"),
  };
  let touching = false;
  const check = () => {
    if (touching) return;
    let moved = false;
    for (const drawer of DRAWERS) {
      const next = headed(drawer);
      if (next === null) continue;
      if (open[drawer] !== null && next !== open[drawer]) moved = true;
      open[drawer] = next;
    }
    if (moved) tap(win);
  };

  // A tap on a button or the backdrop changes a shelf with no finger down.
  const shelves = new win.MutationObserver(check);
  shelves.observe(doc.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ATTRIBUTES,
  });

  // BB answers a swipe's release in its own listeners, after this one.
  const touch = (event: TouchEvent) => {
    touching = event.touches.length > 0;
    if (!touching) win.setTimeout(check);
  };
  const listen = { capture: true, passive: true };
  const types = ["touchstart", "touchend", "touchcancel"] as const;
  for (const type of types) win.addEventListener(type, touch, listen);

  return () => {
    shelves.disconnect();
    for (const type of types) win.removeEventListener(type, touch, listen);
  };
}
