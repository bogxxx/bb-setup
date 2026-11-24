import { isKeyboardInputElement } from "../components/ui/overlay-trigger";

// BB gives a field the focus by itself: the message field when a thread opens,
// the terminal when its tab opens, the search on a new tab. It holds back on a
// touch screen, where the focus brings up the keyboard, but knows one only by
// (pointer: coarse). Since the 2026.26 update a Tesla's browser reports a fine
// pointer, so there the car's keyboard comes up with every thread and tab, even
// one a voice agent opens.

// Since that update a Tesla's browser also reads as desktop Chrome on Linux,
// and only its touch screen tells it apart.
const LINUX = /\(X11; (?:GNU\/)?Linux\b/;
// A tap on the box around a field focuses the field within the tap.
const BOX = "[data-promptbox], [data-app-terminal]";

// The UI Polish setting; app.tsx keeps it current.
let enabled = true;
export function setEnabled(on: boolean) {
  enabled = on;
}

/** On a Tesla, BB focuses a field only in a tap on its box or a key press. */
export function start() {
  if (!tesla()) return;
  // BB may have focused a field before the plugin started.
  const active = document.activeElement;
  if (enabled && active && isKeyboardInputElement(active)) active.blur();
  const prototype = HTMLElement.prototype;
  const original = prototype.focus;
  let on = true;
  function focus(this: HTMLElement, options?: FocusOptions) {
    if (on && enabled && isKeyboardInputElement(this) && !asked(this)) return;
    original.call(this, options);
  }
  prototype.focus = focus;
  return () => {
    on = false;
    // Another script may have wrapped focus since; this one then passes through.
    if (prototype.focus === focus) prototype.focus = original;
  };
}

function tesla() {
  return (
    LINUX.test(navigator.userAgent) &&
    navigator.maxTouchPoints > 0 &&
    !matchMedia("(pointer: coarse)").matches
  );
}

/** Whether the page is handling a key press, or a tap on the field's box. */
function asked(field: HTMLElement) {
  // BB's focus when a thread or a tab opens, or after dictation, comes outside
  // any event, or in a tap on the thread or the tab.
  const { event } = window;
  if (event instanceof KeyboardEvent) return true;
  // A click with no count comes from a key or a script: Enter on a button, or a
  // number that Hotkeys turns into a click on a control.
  if (event instanceof MouseEvent && event.type === "click" && !event.detail)
    return true;
  const tap =
    event instanceof MouseEvent ||
    (typeof TouchEvent === "function" && event instanceof TouchEvent);
  const box = field.closest(BOX) ?? field;
  return tap && event.target instanceof Node && box.contains(event.target);
}
