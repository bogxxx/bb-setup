// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startPanelSwipe } from "./swipe";

// jsdom has no matchMedia; a test flips `matches` to leave the phone.
const phone = Object.assign(new EventTarget(), { matches: true });
const WIDTH = 400;
let stop = () => {};
let clicks = 0;

beforeEach(() => {
  phone.matches = true;
  clicks = 0;
  window.matchMedia = vi.fn(() => phone) as unknown as typeof window.matchMedia;
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  document.body.innerHTML = `
    <main data-sidebar="inset" data-panel-shelf="closed">
      <div data-thread-header-pane-actions>
        <button aria-label="Show right panel (⌘B)"></button>
      </div>
      <p>Reply</p>
      <textarea aria-label="Message"></textarea>
    </main>
    <div data-testid="secondary-panel-shelf" data-state="closed"></div>`;
  button().addEventListener("click", () => {
    clicks += 1;
    page().dataset.panelShelf = "full";
  });
  stop = startPanelSwipe(document);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  document.body.replaceChildren();
});

const page = () => document.querySelector<HTMLElement>("main")!;
const panel = () =>
  document.querySelector<HTMLElement>('[data-testid="secondary-panel-shelf"]')!;
const button = () => document.querySelector<HTMLElement>("button")!;
const reply = () => document.querySelector("p")!;

function touch(element: Element, type: string, x: number, y = 300) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = type === "touchend" ? [] : [{ identifier: 1, clientX: x, clientY: y }];
  Object.defineProperty(event, "touches", { value: touches });
  element.dispatchEvent(event);
  return event;
}

/** A finger that lands at x, slides to each of the points, and lifts. */
function swipe(element: Element, x: number, ...to: number[]) {
  touch(element, "touchstart", x);
  for (const point of to) touch(element, "touchmove", point);
  touch(element, "touchend", to.at(-1) ?? x);
}

it("moves the page with a finger from the right edge", () => {
  touch(reply(), "touchstart", WIDTH - 10);
  const move = touch(reply(), "touchmove", WIDTH - 110);
  expect(move.defaultPrevented).toBe(true);
  expect(page().style.translate).toBe("-100px");
  expect(page().style.transition).toBe("none");
  expect(panel().style.visibility).toBe("visible");
});

it("opens the panel when the finger goes a third of the way", () => {
  swipe(reply(), WIDTH - 10, WIDTH - 60, WIDTH - 150);
  expect(clicks).toBe(1);
  // BB's styles take the page from there.
  expect(page().style.translate).toBe("");
  expect(panel().style.visibility).toBe("");
});

it("holds the page where the finger left it until BB opens the panel", async () => {
  const late = button().cloneNode() as HTMLElement;
  button().replaceWith(late);
  let clicked = false;
  late.addEventListener("click", () => (clicked = true));
  touch(reply(), "touchstart", WIDTH - 10);
  touch(reply(), "touchmove", WIDTH - 60);
  touch(reply(), "touchmove", WIDTH - 150);
  touch(reply(), "touchend", WIDTH - 150);
  expect(clicked).toBe(true);
  // BB's sidebar swipe clears the page's styles on release.
  page().style.translate = page().style.transition = "";
  await Promise.resolve();
  expect(page().style.translate).toBe("-140px");
  expect(page().style.transition).toContain("220ms");
  page().dataset.panelShelf = "full";
  await Promise.resolve();
  expect(page().style.translate).toBe("");
  expect(panel().style.visibility).toBe("");
});

it("slides the page back after a short, slow swipe", () => {
  vi.useFakeTimers();
  touch(reply(), "touchstart", WIDTH - 10);
  touch(reply(), "touchmove", WIDTH - 60);
  vi.advanceTimersByTime(200);
  touch(reply(), "touchend", WIDTH - 60);
  expect(clicks).toBe(0);
  expect(page().style.translate).toBe("0px");
  expect(page().style.transition).toContain("220ms");
  vi.advanceTimersByTime(220);
  expect(page().style.translate).toBe("");
  expect(panel().style.visibility).toBe("");
});

it("ignores a finger away from the edge", () => {
  swipe(reply(), WIDTH - 100, WIDTH - 300);
  expect(clicks).toBe(0);
  expect(page().style.translate).toBe("");
});

it("ignores a finger that goes down", () => {
  touch(reply(), "touchstart", WIDTH - 10, 300);
  touch(reply(), "touchmove", WIDTH - 20, 360);
  touch(reply(), "touchmove", WIDTH - 200, 380);
  touch(reply(), "touchend", WIDTH - 200, 380);
  expect(clicks).toBe(0);
});

it("ignores fields and an open panel", () => {
  swipe(document.querySelector("textarea")!, WIDTH - 10, WIDTH - 60, WIDTH - 200);
  page().dataset.panelShelf = "full";
  swipe(reply(), WIDTH - 10, WIDTH - 60, WIDTH - 200);
  expect(clicks).toBe(0);
});

it("leaves wider screens alone", () => {
  phone.matches = false;
  swipe(reply(), WIDTH - 10, WIDTH - 60, WIDTH - 200);
  expect(clicks).toBe(0);
});

it("stops", () => {
  stop();
  swipe(reply(), WIDTH - 10, WIDTH - 60, WIDTH - 200);
  expect(clicks).toBe(0);
});
