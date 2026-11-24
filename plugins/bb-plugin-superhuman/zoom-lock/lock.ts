const PHONE = "(width < 48rem) and (pointer: coarse)";
const PREVIEW = '[role="dialog"]:has([aria-label="Close image preview"])';
const LIMITS = "maximum-scale=1, user-scalable=no";
const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

function point(touches: TouchList) {
  const [a, b] = Array.from(touches);
  return {
    x: b ? (a.clientX + b.clientX) / 2 : a.clientX,
    y: b ? (a.clientY + b.clientY) / 2 : a.clientY,
    distance: b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0,
  };
}

/** Keep the browser at 100%; fullscreen images own their pinch and pan. */
function startLock(doc: Document) {
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  const original = meta?.content ?? "";
  const locked = original ? `${original}, ${LIMITS}` : LIMITS;
  if (meta) meta.content = locked;
  const roots = [doc.documentElement, doc.body];
  const actions = roots.map((root) => root.style.touchAction);
  for (const root of roots) root.style.touchAction = "manipulation";

  let image: HTMLImageElement | null = null;
  let transform = "";
  let scale = 1, x = 0, y = 0, dragged = false;
  let gesture: (ReturnType<typeof point> & {
    scale: number; xOffset: number; yOffset: number;
    cx: number; cy: number; width: number; height: number;
  }) | null = null;
  const restoreImage = () => { if (image) image.style.transform = transform; };
  // A preview's Previous and Next load another image into the same <img>,
  // which starts unzoomed.
  const loaded = (event: Event) => {
    if (event.target !== image || (scale === 1 && !x && !y)) return;
    restoreImage();
    scale = 1;
    x = y = 0;
    gesture = null;
  };
  const start = (event: TouchEvent) => {
    if (!event.touches.length) { gesture = null; return; }
    const preview = event.target instanceof Element ? event.target.closest(PREVIEW) : null;
    const next = preview?.querySelector("img") ?? null;
    if (next !== image) {
      restoreImage();
      image = next;
      transform = image?.style.transform ?? "";
      scale = 1;
      x = y = 0;
    }
    if (!image) { gesture = null; return; }
    if (event.type === "touchstart" && event.touches.length === 1) dragged = false;
    const rect = image.getBoundingClientRect();
    gesture = {
      ...point(event.touches), scale, xOffset: x, yOffset: y,
      cx: rect.left + rect.width / 2 - x, cy: rect.top + rect.height / 2 - y,
      width: rect.width / scale, height: rect.height / scale,
    };
    if (event.touches.length > 1) {
      dragged = true;
      event.preventDefault();
    }
  };
  const move = (event: TouchEvent) => {
    if (!gesture || !image || !event.touches.length) return;
    const next = point(event.touches);
    if (!next.distance && scale === 1) return;
    event.preventDefault();
    dragged = true;
    if (next.distance && gesture.distance) {
      scale = Math.max(1, Math.min(8, gesture.scale * next.distance / gesture.distance));
    }
    const ratio = scale / gesture.scale;
    x = clamp(next.x - gesture.cx - (gesture.x - gesture.cx - gesture.xOffset) * ratio,
      gesture.width * (scale - 1) / 2);
    y = clamp(next.y - gesture.cy - (gesture.y - gesture.cy - gesture.yOffset) * ratio,
      gesture.height * (scale - 1) / 2);
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  };
  const click = (event: MouseEvent) => {
    if (dragged && event.target instanceof Element && event.target.closest(PREVIEW)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      dragged = false;
    }
  };
  // Safari ignores viewport limits in browser tabs, so cancel native gestures.
  const cancel = (event: Event) => event.preventDefault();
  const options = { capture: true, passive: false };
  for (const type of ["gesturestart", "gesturechange"]) doc.addEventListener(type, cancel, options);
  for (const type of ["touchstart", "touchend", "touchcancel"] as const) doc.addEventListener(type, start, options);
  doc.addEventListener("touchmove", move, options);
  doc.addEventListener("click", click, true);
  doc.addEventListener("load", loaded, true);
  return () => {
    restoreImage();
    if (meta?.content === locked) meta.content = original;
    for (const type of ["gesturestart", "gesturechange"]) doc.removeEventListener(type, cancel, true);
    for (const type of ["touchstart", "touchend", "touchcancel"] as const) doc.removeEventListener(type, start, true);
    doc.removeEventListener("touchmove", move, true);
    doc.removeEventListener("click", click, true);
    doc.removeEventListener("load", loaded, true);
    roots.forEach((root, index) => { root.style.touchAction = actions[index]; });
  };
}

/** Mobile Layout follows viewport changes and leaves desktop zoom alone. */
export function lockZoom(doc: Document): () => void {
  const phone = doc.defaultView!.matchMedia(PHONE);
  let stop = () => {};
  const sync = () => { stop(); stop = phone.matches ? startLock(doc) : () => {}; };
  phone.addEventListener("change", sync);
  sync();
  return () => { phone.removeEventListener("change", sync); stop(); };
}
