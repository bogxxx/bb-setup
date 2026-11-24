import type { useSdk } from "@get-bb/plugin-sdk/app";
import { changedOutside, LIVE_OUTPUT } from "../lib/mutations";
import { physicalKey } from "./key";

type Bindings = Awaited<
  ReturnType<ReturnType<typeof useSdk>["system"]["config"]>
>["keybindings"];
type Modifier = "ctrlKey" | "altKey" | "shiftKey" | "metaKey";
type Chord = Record<Modifier, boolean> & { key: string };

// BB's own reading of the platform, for the shortcuts it saves per platform.
const mac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const windows = !mac && /Win|windows|win32/.test(navigator.platform);
const desktop = !!Reflect.get(window, "bbDesktop");
const SYMBOLS: Record<Modifier, string> = mac
  ? { ctrlKey: "⌃", altKey: "⌥", shiftKey: "⇧", metaKey: "⌘" }
  : { ctrlKey: "Ctrl", altKey: "Alt", shiftKey: "Shift", metaKey: "Meta" };
const MODIFIERS = Object.keys(SYMBOLS) as Modifier[];
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "AltGraph", "Meta", "OS"]);
const NONE = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
// ⇧ and ⌥ also type text, so their hints wait for the modifier held alone this
// long, and a capital letter typed with Shift does no hint work at all.
export const HOLD_MS = 300;
const PANEL =
  ':is([role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"])';
const HIDDEN = `[inert], [aria-hidden="true"], ${PANEL}[data-state="closed"]`;
const EDITABLE =
  'input, textarea, select, iframe, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"], .monaco-editor, [data-app-terminal], [data-app-browser]';
const ITEM =
  '[role="option"], [role="menuitem"], [role="menuitemradio"], button';
const ROW = "[data-sidebar-thread-shortcut-target]";
// The new-thread project, model, machine, branch and role controls, in number order.
const CONTROLS = [
  "[data-promptbox-project-control]",
  'button[aria-label^="Provider, model and reasoning"]',
  'button[aria-label="Environment"][data-promptbox-shrinkable-control], button[aria-label="Machine"]',
  'button[aria-label="Worktree"], button[aria-label="Branch"], button[aria-label="Environment"][data-promptbox-icon-only-control]',
  "label:has(select[data-role-picker-select]:not(:disabled))",
];
const CONTROL = CONTROLS.join(", ");
const MODEL = CONTROLS[1];
const [KEY, MODE, ANCHOR, HINTS] = ["key", "mode", "anchor", "hints"].map(
  (name) => `data-superhuman-${name}`,
);

let settings: Record<string, unknown> = {};
let bindings: Bindings = [];
let boundChords: (Chord | undefined)[] = [];
let running = false;
let mods: Record<Modifier, boolean> = NONE;
let held = false;
let holding = 0;
let chorded = false;
let tagged: HTMLElement[] = [];
let frame = 0;
let dismissed: Element | null = null;
let unhiding = 0;
/** Each returns whether it ran; Snooze can be off. */
let threadActions: { snooze(): boolean; archive(): boolean } | undefined;

/** Receives the plugin settings and BB's resolved keybindings. */
export function update(next: {
  settings?: typeof settings;
  bindings?: Bindings;
  threadActions?: typeof threadActions;
}) {
  if ("threadActions" in next) threadActions = next.threadActions;
  if (!next.settings && !next.bindings) return;
  settings = next.settings ?? settings;
  bindings = next.bindings ?? bindings;
  boundChords = bindings.map(chordFor);
  paint();
}

// Whether the element has a box. checkVisibility needs style but, unlike
// getClientRects, no layout.
const shown = (element: Element) =>
  element.checkVisibility?.() ?? element.getClientRects().length > 0;
const usable = (element: Element) =>
  shown(element) &&
  !element.matches(':disabled, [aria-disabled="true"]') &&
  !element.closest(HIDDEN);
const editable = (target: EventTarget | null) =>
  target instanceof Element && !!target.closest(EDITABLE);

/** Open menus and dialogs, the most recent last. */
function panels() {
  const open = [...document.querySelectorAll(PANEL)].filter(usable);
  return open.filter(
    (panel) => !open.some((other) => other !== panel && other.contains(panel)),
  );
}

function composer() {
  const find = (root: ParentNode, selector: string) =>
    [...root.querySelectorAll<HTMLElement>(selector)].find(shown);
  const shell = find(document, CONTROLS[0])?.closest("[data-promptbox-shell]");
  if (!shell) return;
  const controls = CONTROLS.map((selector) => find(shell, selector)).filter(
    (control): control is HTMLElement =>
      !!control && !control.matches(":disabled"),
  );
  const open = controls.find((control) => control.ariaExpanded === "true");
  return {
    controls,
    open,
    prompt: shell.querySelector<HTMLElement>('[contenteditable="true"]'),
  };
}

/** The setup controls, or the options of the menu one of them opened. */
function numbered(setup = composer()): HTMLElement[] {
  const focus = document.activeElement;
  if (focus !== dismissed) dismissed = null;
  if (!setup || settings.threadShortcuts === false) return [];
  if (mods.ctrlKey || mods.altKey || mods.metaKey) return [];
  if (setup.open) {
    const panel = panels().at(-1);
    // Typed filters and forms such as New project keep their keys.
    const typed = focus instanceof HTMLInputElement && !!focus.value;
    if (!panel || typed || panel.querySelector("form")) return [];
    // In the model picker, numbers choose the provider.
    if (setup.open.matches(MODEL))
      return [...panel.querySelectorAll<HTMLElement>("button[title]")].filter(
        (tab) => usable(tab) && !tab.textContent?.trim(),
      );
    return [...panel.querySelectorAll<HTMLElement>(ITEM)].filter(
      (item) => usable(item) && !item.parentElement?.closest(ITEM),
    );
  }
  const { prompt } = setup;
  // A typed prompt ends it here, before the look for open panels.
  if (!prompt || prompt.textContent || prompt.querySelector("img") || dismissed)
    return [];
  const elsewhere = editable(focus) && !prompt.contains(focus);
  return !elsewhere && !panels().length ? setup.controls : [];
}

/** BB's current shortcut for a command on this platform and surface. */
function binding(command: string): Chord | undefined {
  return boundChords.find((chord, i) => chord && bindings[i]!.command === command);
}

function chordFor(item: Bindings[number]): Chord | undefined {
  const context: Record<string, boolean> = {
    macPlatform: mac,
    windowsPlatform: windows,
    linuxPlatform: !mac && !windows,
    webSurface: !desktop,
    desktopSurface: desktop,
  };
  const shortcut = item.shortcut;
  if (!shortcut || (!desktop && item.desktopOnly)
    || !item.when.all.every((key) => context[key] ?? true)
    || item.when.none.some((key) => context[key])) return;
  const { key, mod, control, alt, shift, meta } = shortcut;
  return {
    key,
    ctrlKey: control || (mod && !mac),
    altKey: alt,
    shiftKey: shift,
    metaKey: meta || (mod && mac),
  };
}

/** Reads `aria-keyshortcuts`, such as "Shift+Meta+M". */
const parse = (value: string): Chord[] =>
  value
    .split(" ")
    .filter(Boolean)
    .map((chord) => ({
      key: chord.split("+").at(-1) || "+",
      ctrlKey: chord.includes("Control+"),
      altKey: chord.includes("Alt+"),
      shiftKey: chord.includes("Shift+"),
      metaKey: chord.includes("Meta+"),
    }));

/** The keys still needed while the held modifiers stay down, like "⇧ M". */
function remaining(chord?: Chord) {
  if (!chord || MODIFIERS.some((key) => mods[key] && !chord[key])) return;
  const keys = MODIFIERS.filter((key) => chord[key] && !mods[key]).map(
    (key) => SYMBOLS[key],
  );
  keys.push(chord.key.length > 1 ? chord.key : chord.key.toUpperCase());
  return keys.join(mac ? " " : " + ");
}

/** Hints for the visible shortcuts while a modifier is held. */
function hints(pills: Map<HTMLElement, string>) {
  if (settings.threadShortcuts === false) return;
  if (!held || !MODIFIERS.some((key) => mods[key])) return;
  const top = panels().at(-1);
  const add = (element: HTMLElement, chords: (Chord | undefined)[]) => {
    const keys = [...new Set(chords.map(remaining).filter(Boolean))];
    const inactive = element.closest(
      '[data-split-pane-id][data-focused="false"]',
    );
    if (
      keys.length &&
      usable(element) &&
      (!top || top.contains(element)) &&
      !inactive
    )
      pills.set(element, keys.join(" / "));
  };
  for (const element of document.querySelectorAll<HTMLElement>(
    "[aria-keyshortcuts]",
  ))
    add(element, parse(element.getAttribute("aria-keyshortcuts")!));
  // BB labels the rows itself while its own hints show, and split panes take
  // the numbers. Like BB, count only the rows on show: a collapsed group keeps
  // its rows in the DOM.
  const rows = [...document.querySelectorAll<HTMLElement>(ROW)].filter(
    (row) =>
      !row.closest('[data-sidebar-overflow="true"]') &&
      row.checkVisibility?.({ visibilityProperty: true }) !== false,
  );
  if (rows.some((row) => row.hasAttribute("aria-keyshortcuts"))) return;
  if (document.querySelectorAll("[data-split-pane-id]").length > 1) return;
  rows
    .slice(0, 9)
    .forEach((row, i) => add(row, [binding(`thread.jump.${i + 1}`)]));
}

/** Marks the controls that get a pill; app.css draws it. */
function paint() {
  if (!running) return;
  const setup = composer();
  const items = numbered(setup).slice(0, 10);
  const tabs = items.length > 0 && !!setup?.open?.matches(MODEL);
  const pills = new Map(items.map((item, i) => [item, `${(i + 1) % 10}`]));
  if (!pills.size) hints(pills);
  hideNativeHints(!items.length && pills.size > 0);
  // Measure every host before marking any, so one layout serves them all.
  const marks = [...pills].map(([element, key]) => {
    const host =
      (element.matches(ROW) &&
        element.closest<HTMLElement>("[data-sidebar-rename-row]")) ||
      element;
    const { width, height } = host.getBoundingClientRect();
    const chevron = host.lastElementChild?.matches('svg[data-icon^="Chevron"]');
    const mode = tabs
      ? "tab"
      : chevron
        ? "chevron"
        : width <= 44 && height <= 44
          ? "icon"
          : "end";
    // A pill laid over its control needs a positioned host.
    const anchor =
      host.hasAttribute(ANCHOR) || getComputedStyle(host).position === "static";
    return { host, key, mode, anchor: anchor && (mode === "icon" || mode === "end") };
  });
  const hosts = marks.map(({ host }) => host);
  for (const element of tagged) if (!hosts.includes(element)) clear(element);
  for (const { host, key, mode, anchor } of marks) {
    mark(host, KEY, key);
    mark(host, MODE, mode);
    host.toggleAttribute(ANCHOR, anchor);
  }
  tagged = hosts;
}

/**
 * BB's own hints follow 700 ms later beside many of the same controls, so
 * app.css hides them while pills show. BB clears them on its next render, after
 * the frame that clears the pills, so they stay hidden a moment longer; that
 * also covers the wait before the pills return under a modifier still held.
 */
function hideNativeHints(hide: boolean) {
  const root = document.documentElement;
  if (hide) {
    clearTimeout(unhiding);
    unhiding = 0;
    if (!root.hasAttribute(HINTS)) root.setAttribute(HINTS, "");
  } else if (root.hasAttribute(HINTS) && !unhiding) {
    unhiding = window.setTimeout(() => {
      unhiding = 0;
      root.removeAttribute(HINTS);
    }, HOLD_MS + 100);
  }
}

/** Sets an attribute only when it changes, since each write restyles. */
function mark(element: Element, name: string, value: string) {
  if (element.getAttribute(name) !== value) element.setAttribute(name, value);
}

function clear(element: Element) {
  for (const name of [KEY, MODE, ANCHOR]) element.removeAttribute(name);
}

function schedule() {
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    paint();
  });
}

/**
 * A fresh ⌘ shows hints at once. Any other key under a modifier, such as the 1
 * of ⌘1, hides them until the modifiers are released, so the thread switch or
 * copy it starts does no hint work; until then, as for ⇧ and ⌥, which also
 * type text, hints show once the modifiers stay down with no other key for
 * HOLD_MS. ⌃ waits too: on Windows and Linux it starts every copy and paste,
 * and hints at once flashed over the sidebar with each one. AltGr, which
 * Windows reports as Ctrl+Alt, types text too.
 */
function wait(event: KeyboardEvent | null) {
  clearTimeout(holding);
  const down = MODIFIERS.some((key) => mods[key]);
  if (!down) chorded = false;
  else if (event && !MODIFIER_KEYS.has(event.key)) chorded = true;
  const altGraph = !!event?.getModifierState("AltGraph");
  held = down && !chorded && mods.metaKey && !mods.ctrlKey && !altGraph;
  if (!held && down)
    holding = window.setTimeout(() => {
      held = true;
      paint();
    }, HOLD_MS);
}

function keydown(event: KeyboardEvent) {
  // Skip our own search shortcut.
  if (!event.isTrusted) return;
  mods = event;
  if (handle(event)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  // Windows repeats a held modifier, which changes nothing.
  if (event.repeat && MODIFIER_KEYS.has(event.key)) return;
  wait(event);
  // Typing changes no pill before the next frame, so paint at most once a frame.
  schedule();
}

export function handle(event: KeyboardEvent): boolean {
  if (settings.threadShortcuts === false || event.isComposing || event.keyCode === 229 || event.defaultPrevented
    || event.getModifierState("AltGraph")) return false;
  if (event.ctrlKey || event.metaKey || event.altKey) {
    normalizeShortcut(event);
    return false;
  }
  const key = physicalKey(event);
  if (key === "/" || key === "h" || key === "e") {
    if (event.shiftKey || event.repeat || settings.threadShortcuts === false
      || editable(event.target) || panels().length) return false;
    if (key === "/") return search();
    if (!threadActions) return false;
    return threadActions[key === "h" ? "snooze" : "archive"]();
  }
  if (key !== "escape" && !/^[0-9]$/.test(key)) return false;
  const setup = composer();
  const items = numbered(setup);
  if (key === "escape") {
    // Hide the numbers so the prompt can start with a digit.
    if (!items.length || setup?.open) return false;
    dismissed = document.activeElement ?? document.body;
    return true;
  }
  const target = items[(Number(key) + 9) % 10];
  if (target && !event.repeat) {
    const select = target instanceof HTMLLabelElement ? target.control : null;
    if (select instanceof HTMLSelectElement) {
      // showPicker opens the native menu; a missing or thrown call uses the label.
      select.focus();
      try {
        select.showPicker();
      } catch {
        target.click();
      }
    } else {
      target.click();
    }
    // A provider is the whole model choice, so close its picker.
    if (setup?.open?.matches(MODEL)) setup.open.click();
  }
  return !!target;
}

/** Let BB resolve scope, availability and user overrides on the original event. */
function normalizeShortcut(event: KeyboardEvent) {
  if (event.target instanceof Element
    && event.target.closest("[data-app-terminal], [data-app-browser]")) return;
  const keys = boundChords
    .filter((chord) => chord && MODIFIERS.every((mod) => chord[mod] === event[mod]))
    .map((chord) => chord!.key.toLowerCase());
  // An explicitly bound character takes precedence over a physical fallback.
  if (keys.includes(event.key.toLowerCase())) return;
  const key = physicalKey(event);
  if (keys.includes(key)) {
    Object.defineProperty(event, "key", { configurable: true, value: key });
  }
}

/** Presses BB's Search threads shortcut, or picks it in the command palette. */
function search() {
  const direct = binding("thread.search");
  const chord = direct ?? binding("palette.open");
  if (!chord) return false;
  const code =
    chord.key.length > 1 ? chord.key : `Key${chord.key.toUpperCase()}`;
  const init = { ...chord, code, bubbles: true, cancelable: true };
  const target = document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  const until = Date.now() + 1000;
  const pick = () => {
    const entry = [
      ...document.querySelectorAll<HTMLElement>(
        '[data-palette-action-kind="drill-in"]',
      ),
    ].find((item) => item.textContent?.startsWith("Search threads"));
    if (entry) entry.click();
    else if (running && Date.now() < until) requestAnimationFrame(pick);
  };
  if (!direct) pick();
  return true;
}

function release(event: Event) {
  mods = event instanceof KeyboardEvent ? event : NONE;
  wait(event instanceof KeyboardEvent ? event : null);
  schedule();
}

function focusin(event: FocusEvent) {
  // Closed menus return focus to their control, but typing continues in the prompt.
  const { target } = event;
  if (!event.relatedTarget && target instanceof HTMLElement && target.matches(CONTROL)) {
    const setup = composer();
    if (setup?.controls.includes(target) && !setup.open) setup.prompt?.focus();
  }
  schedule();
}

// Changes to the chat and terminals, many a second while agents work, matter
// only to the hints of a held modifier.
const observed = (records: MutationRecord[]) => {
  if (held || changedOutside(records, LIVE_OUTPUT)) schedule();
};

export function start({ signal }: { signal: AbortSignal }) {
  // Phones and tablets have no keys to show or press.
  if (matchMedia("(pointer: coarse)").matches) return;
  const options = { capture: true, signal };
  window.addEventListener("keydown", keydown, options);
  window.addEventListener("keyup", release, options);
  // Not captured, since every element blur would release the modifiers.
  window.addEventListener("blur", release, { signal });
  document.addEventListener("focusin", focusin, options);
  document.addEventListener("focusout", schedule, options);
  document.addEventListener("input", schedule, options);
  const observer = new MutationObserver(observed);
  const attributeFilter = ["aria-expanded", "aria-keyshortcuts", "data-state"];
  observer.observe(document.body, {
    subtree: true,
    childList: true,
    attributeFilter,
  });
  running = true;
  paint();
  return () => {
    running = false;
    observer.disconnect();
    cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(holding);
    held = false;
    chorded = false;
    tagged.forEach(clear);
    tagged = [];
    clearTimeout(unhiding);
    unhiding = 0;
    document.documentElement.removeAttribute(HINTS);
    mods = NONE;
    dismissed = null;
  };
}
