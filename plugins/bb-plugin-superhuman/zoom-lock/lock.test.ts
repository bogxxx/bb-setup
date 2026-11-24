// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { lockZoom } from "./lock";

let stop: () => void;
let media: MediaQueryList;
let meta: HTMLMetaElement;
const viewport = "width=device-width, initial-scale=1";
beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: true }) as MediaQueryList;
  vi.stubGlobal("matchMedia", () => media);
  document.head.innerHTML = `<meta name="viewport" content="${viewport}">`;
  meta = document.querySelector("meta")!;
});
afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
  document.head.replaceChildren();
  document.body.replaceChildren();
});
function pinch() {
  const event = new Event("gesturestart", { cancelable: true });
  document.dispatchEvent(event);
  return event.defaultPrevented;
}
function preview() {
  document.body.innerHTML = `<div role="dialog"><button aria-label="Close image preview"></button><img></div>`;
  const image = document.querySelector("img")!;
  vi.spyOn(image, "getBoundingClientRect").mockReturnValue({
    left: 100, top: 100, width: 200, height: 100,
  } as DOMRect);
  return image;
}
function touch(image: Element, type: string, points: number[][]) {
  const event = new TouchEvent(type, {
    bubbles: true, cancelable: true,
    touches: points.map(([clientX, clientY]) => ({ clientX, clientY }) as Touch),
  });
  image.dispatchEvent(event);
  return event.defaultPrevented;
}

it("locks only the mobile viewport and restores desktop zoom and cleanup", () => {
  stop = lockZoom(document);
  expect(meta.content).toBe(`${viewport}, maximum-scale=1, user-scalable=no`);
  expect(pinch()).toBe(true);
  expect(document.documentElement.style.touchAction).toBe("manipulation");
  Object.assign(media, { matches: false });
  media.dispatchEvent(new Event("change"));
  expect(meta.content).toBe(viewport);
  expect(pinch()).toBe(false);
  Object.assign(media, { matches: true });
  media.dispatchEvent(new Event("change"));
  expect(pinch()).toBe(true);
  stop();
  expect(meta.content).toBe(viewport);
  expect(pinch()).toBe(false);
  expect(document.documentElement.style.touchAction).not.toBe("manipulation");
});

it("pinches and pans the image without changing the page scale or closing its preview", () => {
  const image = preview();
  stop = lockZoom(document);
  touch(image, "touchstart", [[150, 150], [250, 150]]);
  expect(touch(image, "touchmove", [[100, 150], [300, 150]])).toBe(true);
  expect(image.style.transform).toBe("translate(0px, 0px) scale(2)");
  vi.mocked(image.getBoundingClientRect).mockReturnValue({ left: 0, top: 50, width: 400, height: 200 } as DOMRect);
  touch(image, "touchend", [[300, 150]]);
  touch(image, "touchmove", [[320, 160]]);
  expect(image.style.transform).toBe("translate(20px, 10px) scale(2)");
  touch(image, "touchmove", [[1000, 1000]]);
  expect(image.style.transform).toBe("translate(100px, 50px) scale(2)");
  touch(image, "touchend", []);
  expect(image.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(false);
  expect(meta.content).toContain("maximum-scale=1");
  stop();
  expect(image.style.transform).toBe("");
});

it("leaves normal images and taps alone, and resets each newly opened preview", () => {
  const image = preview();
  stop = lockZoom(document);
  touch(image, "touchstart", [[150, 150], [250, 150]]);
  touch(image, "touchmove", [[100, 150], [300, 150]]);
  touch(image, "touchend", []);
  touch(image, "touchstart", [[200, 150]]);
  touch(image, "touchend", []);
  expect(image.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }))).toBe(true);
  const next = preview();
  touch(next, "touchstart", [[150, 150], [250, 150]]);
  touch(next, "touchmove", [[125, 150], [275, 150]]);
  expect(next.style.transform).toBe("translate(0px, 0px) scale(1.5)");
  expect(image.style.transform).toBe("");
  next.parentElement!.removeAttribute("role");
  touch(next, "touchstart", [[150, 150], [250, 150]]);
  expect(touch(next, "touchmove", [[100, 150], [300, 150]])).toBe(false);
  expect(next.style.transform).toBe("");
});

it("starts the next image unzoomed when Previous or Next swaps the preview's image", () => {
  const image = preview();
  stop = lockZoom(document);
  touch(image, "touchstart", [[150, 150], [250, 150]]);
  touch(image, "touchmove", [[125, 150], [275, 150]]);
  touch(image, "touchend", []);
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1.5)");
  image.dispatchEvent(new Event("load"));
  expect(image.style.transform).toBe("");
  touch(image, "touchstart", [[150, 150], [250, 150]]);
  touch(image, "touchmove", [[125, 150], [275, 150]]);
  expect(image.style.transform).toBe("translate(0px, 0px) scale(1.5)");
});
