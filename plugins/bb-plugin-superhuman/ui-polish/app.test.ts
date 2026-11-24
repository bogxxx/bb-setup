// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadPluginApp,
  mountPluginContentScripts,
  type MountedPluginContentScripts,
} from "@get-bb/plugin-sdk/testing/app";
import { asPluginApp } from "../testing";
import { setEnabled } from "./focus";

// A Tesla's browser before the 2026.26 update, and since. Chrome on an Android
// tablet sends the same user agent as a Tesla now does.
const OLD_TESLA =
  "Mozilla/5.0 (X11; GNU/Linux) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Tesla/2026.20.6-2c5a0c9d8f41";
const TESLA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";

// A thread in the sidebar, BB's message box with its padding, a terminal tab,
// a terminal in its padded pane, a new tab's search, and a checkbox.
const PAGE = `
  <a href="#thread" id="thread">A thread</a>
  <form data-promptbox>
    <div class="tiptap ProseMirror" contenteditable="true" role="textbox" tabindex="0"></div>
    <div id="padding"></div>
  </form>
  <button id="terminal-tab">Terminal</button>
  <section data-app-terminal>
    <div id="terminal-padding">
      <div class="xterm">
        <div id="rows"></div>
        <textarea class="xterm-helper-textarea"></textarea>
      </div>
    </div>
  </section>
  <input id="search" type="search">
  <input id="check" type="checkbox">`;

const originalFocus = HTMLElement.prototype.focus;
let mounted: MountedPluginContentScripts | undefined;

beforeEach(() => {
  document.body.innerHTML = PAGE;
});

/** Starts the plugin in a browser; a Tesla's since the update by default. */
async function mount(userAgent = TESLA, maxTouchPoints = 16, coarse = false) {
  Object.defineProperty(navigator, "userAgent", {
    value: userAgent,
    configurable: true,
  });
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: maxTouchPoints,
    configurable: true,
  });
  // jsdom has no matchMedia.
  vi.stubGlobal("matchMedia", (query: string) => {
    expect(query).toBe("(pointer: coarse)");
    return { matches: coarse };
  });
  const app = await loadPluginApp(asPluginApp(() => import("./app")));
  mounted = await mountPluginContentScripts(app, { pluginId: "superhuman" });
}

afterEach(async () => {
  if (mounted && !mounted.inspection.disposed)
    await mounted.lifecycle.dispose();
  mounted = undefined;
  HTMLElement.prototype.focus = originalFocus;
  setEnabled(true);
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "userAgent");
  Reflect.deleteProperty(navigator, "maxTouchPoints");
  document.body.replaceChildren();
});

const field = () => document.querySelector<HTMLElement>(".ProseMirror")!;
const terminal = () =>
  document.querySelector<HTMLElement>(".xterm-helper-textarea")!;
const byId = (id: string) => document.getElementById(id)!;

/** An event on the target, in which BB focuses the element. */
function focusDuring(event: Event, target: Element, element: HTMLElement) {
  const focusElement = () => element.focus();
  document.addEventListener(event.type, focusElement);
  target.dispatchEvent(event);
  document.removeEventListener(event.type, focusElement);
}

/** A tap on the target, in which BB focuses the element. */
function tap(target: Element, element = field()) {
  focusDuring(new MouseEvent("mousedown", { bubbles: true }), target, element);
}

it("mounts its two content scripts", async () => {
  await mount();
  expect(mounted!.inspection.mountedIds).toEqual([
    "ui-polish",
    "ui-polish-inline-vis",
  ]);
});

it("keeps BB from focusing the field by itself in a Tesla's browser", async () => {
  await mount();
  field().focus();
  expect(document.activeElement).toBe(document.body);
});

it("takes the focus from a field BB focused before the plugin started", async () => {
  field().focus();
  await mount();
  expect(document.activeElement).toBe(document.body);
});

it("keeps the field unfocused in a tap outside its box", async () => {
  await mount();
  tap(byId("thread"));
  expect(document.activeElement).toBe(document.body);
  const click = new MouseEvent("click", { bubbles: true, detail: 1 });
  focusDuring(click, byId("thread"), field());
  expect(document.activeElement).toBe(document.body);
});

it("lets a tap on the field's box focus the field", async () => {
  await mount();
  tap(byId("padding"));
  expect(document.activeElement).toBe(field());
});

it("keeps the terminal unfocused when its tab opens", async () => {
  await mount();
  tap(byId("terminal-tab"), terminal());
  expect(document.activeElement).toBe(document.body);
  terminal().focus();
  expect(document.activeElement).toBe(document.body);
});

it("lets a touch on the terminal or its padding focus it", async () => {
  await mount();
  for (const target of ["rows", "terminal-padding"]) {
    const touch = new TouchEvent("touchend", { bubbles: true });
    focusDuring(touch, byId(target), terminal());
    expect(document.activeElement).toBe(terminal());
    terminal().blur();
  }
});

it("keeps a new tab's search unfocused, but not in a tap on it", async () => {
  await mount();
  byId("search").focus();
  expect(document.activeElement).toBe(document.body);
  tap(byId("search"), byId("search"));
  expect(document.activeElement).toBe(byId("search"));
});

it("lets a key press focus a field", async () => {
  await mount();
  focusDuring(
    new KeyboardEvent("keydown", { bubbles: true }),
    document.body,
    field(),
  );
  expect(document.activeElement).toBe(field());
});

it("lets a click that a key makes focus a field", async () => {
  await mount();
  const click = new MouseEvent("click", { bubbles: true });
  focusDuring(click, byId("terminal-tab"), byId("search"));
  expect(document.activeElement).toBe(byId("search"));
});

it("leaves elements that take no typing alone", async () => {
  await mount();
  byId("check").focus();
  expect(document.activeElement).toBe(byId("check"));
  byId("thread").focus();
  expect(document.activeElement).toBe(byId("thread"));
});

it("does nothing in other browsers", async () => {
  for (const [agent, touchPoints, coarse] of [
    // A Linux laptop with no touch screen.
    [TESLA, 0, false],
    // An Android tablet, and a Tesla before the update: BB holds back there.
    [TESLA, 5, true],
    [OLD_TESLA, 16, true],
    [MAC, 0, false],
    [ANDROID, 5, true],
  ] as const) {
    field().focus();
    await mount(agent, touchPoints, coarse);
    expect(HTMLElement.prototype.focus).toBe(originalFocus);
    expect(document.activeElement).toBe(field());
    field().blur();
    field().focus();
    expect(document.activeElement).toBe(field());
    field().blur();
    await mounted!.lifecycle.dispose();
  }
});

it("lets BB focus the field again once the plugin stops", async () => {
  await mount();
  await mounted!.lifecycle.dispose();
  expect(HTMLElement.prototype.focus).toBe(originalFocus);
  field().focus();
  expect(document.activeElement).toBe(field());
});

it("passes the focus through once stopped, under another script's wrapper", async () => {
  await mount();
  const wrapped = HTMLElement.prototype.focus;
  function outer(this: HTMLElement, options?: FocusOptions) {
    wrapped.call(this, options);
  }
  HTMLElement.prototype.focus = outer;
  await mounted!.lifecycle.dispose();
  expect(HTMLElement.prototype.focus).toBe(outer);
  field().focus();
  expect(document.activeElement).toBe(field());
});

it("leaves the focus to BB while the UI Polish setting is off", async () => {
  await mount();
  setEnabled(false);
  field().focus();
  expect(document.activeElement).toBe(field());
});
