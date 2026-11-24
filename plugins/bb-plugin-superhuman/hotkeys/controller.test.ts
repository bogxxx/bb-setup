// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HOLD_MS, handle, start, update } from "./controller";

// jsdom lays nothing out, and only phones and tablets match (pointer: coarse).
vi.stubGlobal("matchMedia", () => ({ matches: false }));
vi.spyOn(Element.prototype, "getClientRects").mockReturnValue({
  length: 1,
} as DOMRectList);

let running: AbortController;
let stop: (() => void) | undefined;

beforeEach(() => {
  document.body.innerHTML = `
    <button aria-keyshortcuts="Shift+Meta+M">Switch model</button>
    <div data-promptbox-shell>
      <div contenteditable="true"></div>
      <button data-promptbox-project-control>Project</button>
      <button aria-label="Provider, model and reasoning">Model</button>
      <button aria-label="Machine">Machine</button>
      <button aria-label="Branch">Branch</button>
    </div>`;
  update({ settings: {}, bindings: [], threadActions: undefined });
  running = new AbortController();
  stop = start({ signal: running.signal });
});

afterEach(() => {
  stop?.();
  running.abort();
});

/** Each control with a pill, and the pill's text. */
const pills = () =>
  [...document.querySelectorAll("[data-superhuman-key]")].map((element) => [
    element.textContent,
    element.getAttribute("data-superhuman-key"),
  ]);

it("numbers a new thread's setup controls unless thread shortcuts are off", () => {
  expect(pills()).toEqual([
    ["Project", "1"],
    ["Model", "2"],
    ["Machine", "3"],
    ["Branch", "4"],
  ]);
  update({ settings: { threadShortcuts: false } });
  expect(pills()).toEqual([]);
});

it("shows the remaining keys at once under ⌘ unless hints are off", () => {
  vi.useFakeTimers();
  window.dispatchEvent(
    new KeyboardEvent("keyup", { key: "Shift", metaKey: true }),
  );
  vi.advanceTimersToNextFrame();
  expect(pills()).toEqual([["Switch model", "Shift + M"]]);
  update({ settings: { threadShortcuts: false } });
  expect(pills()).toEqual([]);
  vi.useRealTimers();
});

it("waits HOLD_MS under ⌃, so a quick copy or paste flashes no pills", () => {
  vi.useFakeTimers();
  document.body.insertAdjacentHTML(
    "afterbegin",
    '<button aria-keyshortcuts="Control+Shift+O">New thread</button>',
  );
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
  vi.advanceTimersToNextFrame();
  expect(pills().some(([text]) => text === "New thread")).toBe(false);
  // Ctrl+C: another key under ⌃ before HOLD_MS shows nothing.
  vi.advanceTimersByTime(HOLD_MS - 50);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true }));
  vi.advanceTimersToNextFrame();
  expect(pills().some(([text]) => text === "New thread")).toBe(false);
  // Held alone, ⌃ shows the pills once HOLD_MS passes.
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "c", ctrlKey: true }));
  vi.advanceTimersByTime(HOLD_MS);
  vi.advanceTimersToNextFrame();
  expect(pills()).toContainEqual(["New thread", "Shift + O"]);
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
  vi.useRealTimers();
});

it("hides BB's own hints while the pills show and a moment after they go", () => {
  vi.useFakeTimers();
  const hidden = () =>
    document.documentElement.hasAttribute("data-superhuman-hints");
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", metaKey: true }));
  vi.advanceTimersByTime(HOLD_MS);
  expect(hidden()).toBe(true);
  // Releasing the modifier clears the pills at once; BB clears its own hints
  // on its next render, so they stay hidden until then.
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Meta" }));
  vi.advanceTimersToNextFrame();
  expect(pills().some(([text]) => text === "Switch model")).toBe(false);
  vi.advanceTimersByTime(HOLD_MS + 99);
  expect(hidden()).toBe(true);
  vi.advanceTimersByTime(1);
  expect(hidden()).toBe(false);
  vi.useRealTimers();
});

it("hides ⌘'s hints for a chord, so ⌘1 does no hint work, until ⌘ rests alone", () => {
  vi.useFakeTimers();
  const key = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keyup", init));
  const hints = () => pills().filter(([text]) => text === "Switch model");
  key({ key: "Shift", metaKey: true });
  vi.advanceTimersToNextFrame();
  expect(hints()).toEqual([["Switch model", "Shift + M"]]);
  // The 1 of ⌘1 switches threads; the hints stay off while BB redraws.
  key({ key: "1", metaKey: true });
  vi.advanceTimersToNextFrame();
  expect(hints()).toEqual([]);
  vi.advanceTimersByTime(HOLD_MS - 20);
  expect(hints()).toEqual([]);
  vi.advanceTimersByTime(20);
  expect(hints()).toEqual([["Switch model", "Shift + M"]]);
  // Released and pressed again, ⌘ shows them at once.
  key({ key: "Meta" });
  vi.advanceTimersToNextFrame();
  expect(pills()).toEqual([
    ["Project", "1"],
    ["Model", "2"],
    ["Machine", "3"],
    ["Branch", "4"],
  ]);
  key({ key: "Shift", metaKey: true });
  vi.advanceTimersToNextFrame();
  expect(hints()).toEqual([["Switch model", "Shift + M"]]);
  vi.useRealTimers();
});

it("waits for ⇧ held alone, so typing capitals skips the hints", () => {
  vi.useFakeTimers();
  const key = (init: KeyboardEventInit) =>
    window.dispatchEvent(new KeyboardEvent("keyup", init));
  // A typed prompt, so the new thread's numbers make way for the hints.
  document.querySelector("[contenteditable]")!.textContent = "Fix";
  const hints = () => pills().filter(([text]) => text === "Switch model");
  key({ key: "a", shiftKey: true });
  vi.advanceTimersByTime(HOLD_MS - 100);
  // Another capital starts the wait over.
  key({ key: "b", shiftKey: true });
  vi.advanceTimersByTime(HOLD_MS - 1);
  expect(hints()).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(hints()).toEqual([["Switch model", "Meta + M"]]);
  vi.useRealTimers();
});

it("rewrites no pill that stays the same, since each write restyles", () => {
  const write = vi.spyOn(Element.prototype, "setAttribute");
  update({ settings: {} });
  expect(write).not.toHaveBeenCalled();
  write.mockRestore();
});

const press = (key: string, code: string, init: KeyboardEventInit = {}) =>
  new KeyboardEvent("keydown", { key, code, ...init });
const binding = (command: "palette.open" | "thread.search" | "thread.new", key: string) => ({
  command, desktopOnly: false, when: { all: [], none: [] },
  shortcut: { key, mod: false, control: true, meta: false, shift: false, alt: false },
});

it.each([
  ["р", "KeyH", "snooze"], ["h", "KeyH", "snooze"], ["י", "KeyH", "snooze"],
  ["ا", "KeyH", "snooze"], ["у", "KeyE", "archive"], ["e", "KeyE", "archive"],
  ["h", "", "snooze"],
] as const)("runs %s at %s using the physical key", (key, code, action) => {
  const actions = { snooze: vi.fn(() => true), archive: vi.fn(() => true) };
  update({ threadActions: actions });
  expect(handle(press(key, code))).toBe(true);
  expect(actions[action]).toHaveBeenCalledOnce();
  expect(actions[action === "snooze" ? "archive" : "snooze"]).not.toHaveBeenCalled();
});

it("uses the number row even when the layout prints a letter there", () => {
  const model = document.querySelector('button[aria-label="Provider, model and reasoning"]')!;
  const choose = vi.fn();
  model.addEventListener("click", choose);
  expect(handle(press("é", "Digit2"))).toBe(true);
  expect(choose).toHaveBeenCalledOnce();
});

it("opens search from the slash position in Russian", () => {
  update({ bindings: [binding("thread.search", "f")] });
  const receive = vi.fn();
  document.body.addEventListener("keydown", receive, { once: true });
  expect(handle(press(".", "Slash"))).toBe(true);
  expect(receive).toHaveBeenCalledOnce();
  expect(receive.mock.calls[0]![0].key).toBe("f");
});

it("preserves typing, composition, repeats, modifiers, dialogs and disabled shortcuts", () => {
  const actions = { snooze: vi.fn(() => true), archive: vi.fn(() => true) };
  update({ threadActions: actions });
  expect(handle(press("h", "KeyJ"))).toBe(false);
  for (const init of [
    { isComposing: true }, { repeat: true }, { ctrlKey: true }, { metaKey: true },
    { altKey: true }, { shiftKey: true }, { keyCode: 229 },
  ]) expect(handle(press("р", "KeyH", init))).toBe(false);
  for (const html of [
    "<input>", "<textarea></textarea>", '<div contenteditable="true"></div>',
    "<div data-app-terminal></div>", "<div data-app-browser></div>",
  ]) {
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    container.addEventListener("keydown", (event) => expect(handle(event)).toBe(false));
    container.firstElementChild!.dispatchEvent(press("р", "KeyH", { bubbles: true }));
    container.remove();
  }
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  document.body.append(dialog);
  expect(handle(press("р", "KeyH"))).toBe(false);
  dialog.remove();
  update({ settings: { threadShortcuts: false } });
  expect(handle(press("р", "KeyH"))).toBe(false);
  expect(actions.snooze).not.toHaveBeenCalled();
  expect(actions.archive).not.toHaveBeenCalled();
});

it("normalizes registered modifier shortcuts, preserving custom character bindings", () => {
  update({ bindings: [binding("palette.open", "k")] });
  const event = press("л", "KeyK", { ctrlKey: true });
  handle(event);
  expect(event.key).toBe("k");
  for (const init of [
    { key: "р", code: "KeyH", ctrlKey: true },
    { key: "л", code: "KeyK" },
    { key: "л", code: "KeyK", ctrlKey: true, isComposing: true },
  ]) {
    const event = new KeyboardEvent("keydown", init);
    handle(event);
    expect(event.key).toBe(init.key);
  }
  update({ bindings: [binding("palette.open", "k"), binding("thread.new", "л")] });
  const custom = press("л", "KeyK", { ctrlKey: true });
  handle(custom);
  expect(custom.key).toBe("л");
});

it("uses the shortcut BB saved for this platform", () => {
  // jsdom reports no platform, which BB reads as Linux.
  type Platform = "windowsPlatform" | "macPlatform" | "linuxPlatform";
  const on = (platform: Platform, key: string) => ({
    ...binding("thread.search", key),
    when: { all: [platform], none: [] },
  });
  update({ bindings: [on("windowsPlatform", "f"), on("macPlatform", "j"), on("linuxPlatform", "g")] });
  const receive = vi.fn();
  document.body.addEventListener("keydown", receive, { once: true });
  expect(handle(press("/", "Slash"))).toBe(true);
  expect(receive.mock.calls[0]![0].key).toBe("g");
});

it("numbers only the sidebar rows on show, as BB does", () => {
  vi.useFakeTimers();
  const jump = (n: number) => ({
    command: `thread.jump.${n}`, desktopOnly: false, when: { all: [], none: [] },
    shortcut: { key: `${n}`, mod: false, control: true, meta: false, shift: false, alt: false },
  });
  update({ bindings: [jump(1), jump(2)] as never });
  const nav = document.createElement("nav");
  nav.innerHTML = `
    <div data-sidebar-rename-row><a data-sidebar-thread-shortcut-target>Collapsed</a><span></span></div>
    <div data-sidebar-rename-row><a data-sidebar-thread-shortcut-target>First</a><span></span></div>
    <div data-sidebar-rename-row><a data-sidebar-thread-shortcut-target>Second</a><span></span></div>`;
  document.body.append(nav);
  // jsdom has no layout; a browser answers this from the rendered box.
  nav.querySelector("a")!.checkVisibility = () => false;
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift", ctrlKey: true }));
  vi.advanceTimersByTime(HOLD_MS);
  expect(pills().filter(([text]) => text !== "Switch model")).toEqual([
    ["First", "1"],
    ["Second", "2"],
  ]);
  nav.remove();
  vi.useRealTimers();
});

it("lets H through when Snooze is off", () => {
  update({ threadActions: { snooze: () => false, archive: () => true } });
  expect(handle(press("h", "KeyH"))).toBe(false);
});
