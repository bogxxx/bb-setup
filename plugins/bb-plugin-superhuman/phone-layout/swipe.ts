const PHONE = "(width < 48rem) and (pointer: coarse)";
const PAGE = 'main[data-sidebar="inset"]';
const PANEL = '[data-testid="secondary-panel-shelf"]';
const PANEL_BUTTON = '[data-thread-header-pane-actions] button[aria-label^="Show right panel"]';
// The places where BB's own swipes don't start either.
const SKIP =
  'input, textarea, select, [contenteditable="true"], [role="slider"], [data-vaul-no-drag], [data-no-sidebar-swipe], [data-no-secondary-panel-swipe]';
// BB's sidebar swipe, mirrored: where a finger starts from the edge, how far it
// goes before the swipe takes it, and how far or how fast opens the panel.
const EDGE = 72;
const LOCK = 12;
const OPEN = 0.33;
const FLICK = 0.12;
const FLICK_SPEED = 450;
const FLICK_AGE = 100;
const SETTLE = 220;
const EASE = `translate ${SETTLE}ms cubic-bezier(0.32, 0.72, 0, 1)`;

interface Swipe {
  id: number;
  x: number;
  y: number;
  target: Element;
  dragging: boolean;
  progress: number;
  lastX: number;
  lastTime: number;
  speed: number;
}

/** Whether the element, or one around it, still scrolls right under a finger that moves left. */
function scrollsRight(win: Window, element: Element | null): boolean {
  for (; element; element = element.parentElement) {
    const { overflowX } = win.getComputedStyle(element);
    const scrolls = overflowX === "auto" || overflowX === "scroll";
    if (scrolls && element.scrollLeft + element.clientWidth < element.scrollWidth - 1)
      return true;
    if (element.matches(PAGE)) return false;
  }
  return false;
}

/**
 * Opens the right panel with a swipe from the screen's right edge on a phone,
 * as a swipe from the left edge opens the sidebar, until the returned function
 * runs. The page follows the finger, and slide.ts keeps the panel on its edge.
 */
export function startPanelSwipe(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const phone = win.matchMedia(PHONE);
  let swipe: Swipe | null = null;
  let settling: number | undefined;
  let opening: MutationObserver | undefined;

  const page = () => doc.querySelector<HTMLElement>(PAGE);
  const panel = () => doc.querySelector<HTMLElement>(PANEL);
  // Hands the page and the panel back to BB's styles.
  const clear = () => {
    win.clearTimeout(settling);
    opening?.disconnect();
    opening = undefined;
    const main = page();
    if (main) main.style.translate = main.style.transition = "";
    const shelf = panel();
    if (shelf) shelf.style.visibility = "";
  };
  const slide = (progress: number, settle: boolean) => {
    const main = page();
    if (!main) return;
    main.style.transition = settle ? EASE : "none";
    main.style.translate = `${-progress * win.innerWidth}px`;
  };

  const back = () => {
    slide(0, true);
    settling = win.setTimeout(clear, SETTLE);
  };

  const start = ({ target, touches }: TouchEvent) => {
    swipe = null;
    if (!phone.matches || touches.length !== 1) return;
    const { identifier, clientX, clientY } = touches[0];
    if (win.innerWidth - clientX > EDGE) return;
    if (!(target instanceof win.Element) || target.closest(SKIP)) return;
    const main = page();
    // Only a thread's page has a closed right panel, and none while the
    // sidebar is open.
    if (!main?.contains(target) || main.dataset.panelShelf !== "closed") return;
    if (!doc.querySelector(PANEL_BUTTON) || !panel()) return;
    clear();
    swipe = {
      id: identifier,
      x: clientX,
      y: clientY,
      target,
      dragging: false,
      progress: 0,
      lastX: clientX,
      lastTime: Date.now(),
      speed: 0,
    };
  };

  const move = (event: TouchEvent) => {
    if (!swipe) return;
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    // A second finger makes it a pinch.
    if (touch?.identifier !== swipe.id) {
      if (swipe.dragging) back();
      swipe = null;
      return;
    }
    const left = swipe.x - touch.clientX;
    const down = Math.abs(touch.clientY - swipe.y);
    if (!swipe.dragging) {
      if (down > LOCK && down > Math.abs(left) * 1.15) {
        swipe = null;
        return;
      }
      if (left < LOCK || Math.abs(left) <= down * 1.25) return;
      if (scrollsRight(win, swipe.target)) {
        swipe = null;
        return;
      }
      swipe.dragging = true;
      // The closed panel waits hidden at the edge until the page uncovers it.
      const shelf = panel();
      if (shelf) shelf.style.visibility = "visible";
    }
    if (event.cancelable) event.preventDefault();
    const now = Date.now();
    if (now > swipe.lastTime) {
      swipe.speed = ((swipe.lastX - touch.clientX) / (now - swipe.lastTime)) * 1000;
      swipe.lastX = touch.clientX;
      swipe.lastTime = now;
    }
    swipe.progress = Math.min(1, Math.max(0, left / win.innerWidth));
    slide(swipe.progress, false);
  };

  const end = (event: TouchEvent) => {
    const done = swipe;
    swipe = null;
    if (!done?.dragging) return;
    if (event.cancelable) event.preventDefault();
    const flick =
      done.progress >= FLICK &&
      done.speed >= FLICK_SPEED &&
      Date.now() - done.lastTime <= FLICK_AGE;
    const button = doc.querySelector<HTMLElement>(PANEL_BUTTON);
    if (event.type === "touchend" && button && (done.progress >= OPEN || flick)) {
      // The page slides on from where the finger left it once BB marks the
      // panel open, and the styles BB then gives it take over. Until then it
      // stays there, though BB's sidebar swipe clears its styles on release.
      const main = page();
      if (!main) return;
      const held = main.style.translate;
      main.style.transition = EASE;
      opening = new win.MutationObserver(() => {
        if (main.dataset.panelShelf !== "closed") clear();
        else if (main.style.translate !== held) {
          main.style.translate = held;
          main.style.transition = EASE;
        }
      });
      opening.observe(main, {
        attributes: true,
        attributeFilter: ["data-panel-shelf", "style"],
      });
      button.click();
      if (main.dataset.panelShelf !== "closed") clear();
      else settling = win.setTimeout(clear, 1000);
      return;
    }
    back();
  };

  const listen = { capture: true, passive: true };
  const drag = { capture: true, passive: false };
  doc.addEventListener("touchstart", start, listen);
  doc.addEventListener("touchmove", move, drag);
  doc.addEventListener("touchend", end, drag);
  doc.addEventListener("touchcancel", end, drag);
  return () => {
    doc.removeEventListener("touchstart", start, listen);
    doc.removeEventListener("touchmove", move, drag);
    doc.removeEventListener("touchend", end, drag);
    doc.removeEventListener("touchcancel", end, drag);
    swipe = null;
    clear();
  };
}
