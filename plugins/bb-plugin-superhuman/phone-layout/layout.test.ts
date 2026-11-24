// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startKeyboardSwipe } from "./keyboard";
import { startPhoneLayout } from "./layout";
import { startPanelSlide } from "./slide";

// jsdom has no matchMedia; a test flips `matches` to leave the phone.
const phone = Object.assign(new EventTarget(), { matches: true });

beforeEach(() => {
  phone.matches = true;
  window.matchMedia = vi.fn(() => phone) as unknown as typeof window.matchMedia;
  document.body.innerHTML = `
    <main data-sidebar="inset"><textarea aria-label="Message"></textarea></main>
    <div data-testid="secondary-panel-shelf">
      <section data-app-terminal>
        <textarea class="xterm-helper-textarea"></textarea>
      </section>
    </div>`;
});

afterEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, "", "/");
});

const page = () => document.querySelector<HTMLElement>("main")!;
const panel = () =>
  document.querySelector<HTMLElement>(
    '[data-testid="secondary-panel-shelf"]',
  )!;
const settle = () => new Promise((resolve) => setTimeout(resolve));
const terminal = () =>
  document.querySelector<HTMLElement>(".xterm-helper-textarea")!;
const message = () =>
  document.querySelector<HTMLElement>('[aria-label="Message"]')!;

/** A finger that lands on the element and slides by x and y. */
function swipe(element: Element, x: number, y: number) {
  const moves = [
    ["touchstart", 0, 0],
    ["touchmove", x, y],
  ] as const;
  for (const [type, dx, dy] of moves) {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, "touches", {
      value: [{ identifier: 1, clientX: 100 + dx, clientY: 100 + dy }],
    });
    element.dispatchEvent(event);
  }
}

it("marks the page for app.css while it is a phone's, until it stops", () => {
  const stop = startPhoneLayout(document);
  expect(document.documentElement.dataset.phoneLayout).toBe("");
  // A screen that turns or a window that widens leaves the phone layout.
  phone.matches = false;
  phone.dispatchEvent(new Event("change"));
  expect(document.documentElement.dataset.phoneLayout).toBeUndefined();
  phone.matches = true;
  phone.dispatchEvent(new Event("change"));
  expect(document.documentElement.dataset.phoneLayout).toBe("");
  stop();
  expect(document.documentElement.dataset.phoneLayout).toBeUndefined();
});

it("slides the right panel out with the page on a phone only", async () => {
  const stop = startPanelSlide(document);
  document.dispatchEvent(new Event("touchstart"));

  page().style.transition = "translate 200ms";
  page().style.translate = "-120px";
  await settle();
  expect(panel().style.translate).toBe("calc(100% - 120px)");
  expect(panel().style.transition).toBe("translate 200ms");

  phone.matches = false;
  page().style.translate = "-60px";
  await settle();
  expect(panel().style.translate).toBe("");

  stop();
});

it("hides the keyboard when a finger swipes down the terminal", () => {
  const stop = startKeyboardSwipe(document);
  terminal().focus();
  swipe(terminal(), 0, 30);
  expect(document.activeElement).toBe(terminal());
  swipe(terminal(), 10, 60);
  expect(document.activeElement).toBe(document.body);

  stop();
  terminal().focus();
  swipe(terminal(), 0, 60);
  expect(document.activeElement).toBe(terminal());
});

it("leaves the keyboard to other swipes, other fields and wider screens", () => {
  const stop = startKeyboardSwipe(document);
  terminal().focus();
  swipe(terminal(), 80, 60);
  swipe(terminal(), 0, -60);
  expect(document.activeElement).toBe(terminal());

  message().focus();
  swipe(terminal(), 0, 60);
  expect(document.activeElement).toBe(message());

  terminal().focus();
  phone.matches = false;
  swipe(terminal(), 0, 60);
  expect(document.activeElement).toBe(terminal());

  stop();
});

/**
 * BB's route change: the sidebar closes, and Settings puts its list of
 * sections in it.
 */
function go(path: string) {
  history.pushState(null, "", path);
  document
    .querySelector("[data-sidebar=panel]")!
    .setAttribute("data-state", "closed");
  const list = document.querySelector('[data-testid="settings-sidebar-body"]');
  if (path.startsWith("/settings") && !list)
    document
      .querySelector("[data-sidebar=panel]")!
      .insertAdjacentHTML(
        "beforeend",
        '<div data-testid="settings-sidebar-body"></div>',
      );
  if (!path.startsWith("/settings")) list?.remove();
}

it("marks the page while a field has the keyboard open, as on Android", () => {
  const view = Object.assign(new EventTarget(), { height: 800 });
  vi.stubGlobal("visualViewport", view);
  window.matchMedia = vi.fn((query: string) =>
    query.includes("orientation") ? { matches: false } : phone,
  ) as unknown as typeof window.matchMedia;
  const open = () => document.documentElement.hasAttribute("data-phone-keyboard");
  const stop = startPhoneLayout(document);
  try {
    // A field with the focus but no keyboard yet, as with a hardware keyboard.
    message().focus();
    expect(open()).toBe(false);
    view.height = 420;
    view.dispatchEvent(new Event("resize"));
    expect(open()).toBe(true);
    message().blur();
    expect(open()).toBe(false);
    // A short viewport without a field, as with the browser's own panels.
    view.dispatchEvent(new Event("resize"));
    expect(open()).toBe(false);
  } finally {
    stop();
    vi.unstubAllGlobals();
  }
  expect(open()).toBe(false);
});
