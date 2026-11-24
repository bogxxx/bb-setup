const PHONE = "(width < 48rem) and (pointer: coarse)";
const TERMINAL = "[data-app-terminal]";
// How far a finger goes down before the keyboard hides: well past the 10px
// within which BB takes a touch for a tap, which opens the keyboard.
const SWIPE = 40;

/**
 * Hides the on-screen keyboard when a finger swipes down the terminal that has
 * it open, until the returned function runs. app.css hides the bars while the
 * keyboard is open, so they can't close it.
 */
export function startKeyboardSwipe(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const phone = win.matchMedia(PHONE);
  let swipe: { id: number; x: number; y: number; terminal: Element } | null =
    null;

  const start = ({ target, touches }: TouchEvent) => {
    swipe = null;
    if (!phone.matches || touches.length !== 1) return;
    const terminal =
      target instanceof win.Element ? target.closest(TERMINAL) : null;
    if (!terminal) return;
    const { identifier, clientX, clientY } = touches[0];
    swipe = { id: identifier, x: clientX, y: clientY, terminal };
  };

  const move = ({ touches }: TouchEvent) => {
    if (!swipe) return;
    // A second finger makes it a pinch.
    const touch = touches.length === 1 ? touches[0] : undefined;
    if (touch?.identifier !== swipe.id) {
      swipe = null;
      return;
    }
    const down = touch.clientY - swipe.y;
    if (down < SWIPE || down < Math.abs(touch.clientX - swipe.x)) return;
    // The terminal has the keyboard while xterm's field in it has the focus.
    // BB gives the field the focus back only on a tap.
    const focused = doc.activeElement;
    if (focused instanceof win.HTMLElement && swipe.terminal.contains(focused))
      focused.blur();
    swipe = null;
  };

  const listen = { capture: true, passive: true };
  doc.addEventListener("touchstart", start, listen);
  doc.addEventListener("touchmove", move, listen);
  return () => {
    doc.removeEventListener("touchstart", start, listen);
    doc.removeEventListener("touchmove", move, listen);
  };
}
