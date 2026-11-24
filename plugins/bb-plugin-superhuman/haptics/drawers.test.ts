// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startDrawerHaptics } from "./drawers";

const post = vi.fn();

beforeEach(() => {
  post.mockClear();
  Object.assign(window, { bb: { native: { capabilities: ["haptic"], post } } });
  document.body.innerHTML = `<main data-sidebar="inset" data-sidebar-shelf="closed" data-panel-shelf="closed"></main>`;
});

afterEach(() => {
  document.body.replaceChildren();
  delete (window as { bb?: unknown }).bb;
});

const page = () => document.querySelector<HTMLElement>("main")!;
const settle = () => new Promise((resolve) => setTimeout(resolve));
const taps = () => post.mock.calls.length;

/** A finger that lands, or lifts with none left on the screen. */
function finger(type: "touchstart" | "touchend", fingers: number) {
  const event = new Event(type);
  Object.defineProperty(event, "touches", { value: { length: fingers } });
  window.dispatchEvent(event);
}

it("taps when a button opens or closes the sidebar", async () => {
  const stop = startDrawerHaptics(document);
  page().dataset.sidebarShelf = "open";
  await settle();
  expect(post).toHaveBeenLastCalledWith({ type: "haptic", kind: "impact-light" });
  page().dataset.sidebarShelf = "closed";
  await settle();
  expect(taps()).toBe(2);

  stop();
  page().dataset.sidebarShelf = "open";
  await settle();
  expect(taps()).toBe(2);
});

it("taps once a swipe lets go, and not for one that springs back", async () => {
  const stop = startDrawerHaptics(document);

  // BB marks the sidebar open as soon as the finger drags it.
  finger("touchstart", 1);
  page().dataset.sidebarShelf = "open";
  page().style.translate = "120px";
  await settle();
  expect(taps()).toBe(0);

  // Let go short of opening: BB slides the page back, then closes the shelf.
  page().style.translate = "0px";
  finger("touchend", 0);
  await settle();
  page().dataset.sidebarShelf = "closed";
  await settle();
  expect(taps()).toBe(0);

  // Let go past it: BB slides the page all the way.
  finger("touchstart", 1);
  page().dataset.sidebarShelf = "open";
  page().style.translate = "300px";
  finger("touchend", 0);
  await settle();
  expect(taps()).toBe(1);

  // Swipe it closed: the tap comes with the release, not with the shelf.
  page().style.translate = "";
  finger("touchstart", 1);
  page().style.translate = "0px";
  finger("touchend", 0);
  await settle();
  expect(taps()).toBe(2);
  page().dataset.sidebarShelf = "closed";
  await settle();
  expect(taps()).toBe(2);
  stop();
});

it("taps as the right panel opens and as a swipe closes it", async () => {
  const stop = startDrawerHaptics(document);
  page().dataset.panelShelf = "full";
  await settle();
  expect(taps()).toBe(1);

  // Let go short of closing: BB slides the page back over the panel.
  finger("touchstart", 1);
  page().style.translate = "-350px";
  page().style.translate = "-390px";
  finger("touchend", 0);
  await settle();
  expect(taps()).toBe(1);

  // Let go past it: the tap comes with the release, not with the shelf.
  page().style.translate = "";
  finger("touchstart", 1);
  page().style.translate = "0px";
  finger("touchend", 0);
  await settle();
  expect(taps()).toBe(2);
  page().dataset.panelShelf = "closed";
  await settle();
  expect(taps()).toBe(2);
  stop();
});

it("stays quiet while the open sidebar hides the panel's shelf", async () => {
  const stop = startDrawerHaptics(document);
  page().dataset.sidebarShelf = "open";
  delete page().dataset.panelShelf;
  await settle();
  page().dataset.sidebarShelf = "closed";
  page().dataset.panelShelf = "closed";
  await settle();
  expect(taps()).toBe(2);
  stop();
});

it("vibrates in a browser without BB's app", async () => {
  delete (window as { bb?: unknown }).bb;
  const vibrate = vi.fn(() => true);
  Object.assign(navigator, { vibrate });
  const stop = startDrawerHaptics(document);
  page().dataset.sidebarShelf = "open";
  await settle();
  expect(vibrate).toHaveBeenCalledWith(10);
  stop();
});
