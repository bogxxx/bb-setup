export const PHONE = "(width < 48rem) and (pointer: coarse)";
// What takes the keyboard: BB's message box, a terminal, a search field.
const TYPING =
  'input, textarea, [contenteditable]:not([contenteditable="false"])';
// The keyboard leaves the page well under this share of its full height.
const KEYBOARD = 0.75;

/**
 * Marks the page for app.css and slide.css while it is a phone's, until the
 * returned function runs. The styles read only this mark, so the layout
 * follows the screen as it turns or a window resizes.
 */
export function startPhoneLayout(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const root = doc.documentElement;
  const phone = win.matchMedia(PHONE);
  const sync = () => root.toggleAttribute("data-phone-layout", phone.matches);
  phone.addEventListener("change", sync);
  sync();
  const stopKeyboard = startKeyboardMark(doc, win);
  return () => {
    phone.removeEventListener("change", sync);
    stopKeyboard();
    root.removeAttribute("data-phone-layout");
  };
}

/**
 * Marks the page while the on-screen keyboard is open, so the bars can give
 * the page their room. BB tells only of an iPhone's, by setting
 * --bb-safe-area-bottom on <body>; elsewhere, as on Android, the keyboard
 * shows as a visual viewport much shorter than it has been in this
 * orientation, while a field has the focus. The page's own height, not the
 * screen's, also suits a window that shares the screen.
 */
function startKeyboardMark(doc: Document, win: Window): () => void {
  const view = win.visualViewport;
  if (!view) return () => {};
  const root = doc.documentElement;
  const landscape = win.matchMedia("(orientation: landscape)");
  let turned = landscape.matches;
  let tallest = 0;
  const sync = () => {
    if (landscape.matches !== turned) {
      turned = landscape.matches;
      tallest = 0;
    }
    tallest = Math.max(tallest, view.height);
    const typing = !!doc.activeElement?.matches(TYPING);
    const open = typing && view.height < tallest * KEYBOARD;
    if (root.hasAttribute("data-phone-keyboard") !== open) {
      root.toggleAttribute("data-phone-keyboard", open);
    }
  };
  view.addEventListener("resize", sync);
  doc.addEventListener("focusin", sync);
  doc.addEventListener("focusout", sync);
  sync();
  return () => {
    view.removeEventListener("resize", sync);
    doc.removeEventListener("focusin", sync);
    doc.removeEventListener("focusout", sync);
    root.removeAttribute("data-phone-keyboard");
  };
}
