// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PAGE, READY, startInlineVis } from "./inline-vis";
import registerUiPolishServer from "./server";

const OFF = "data-superhuman-ui-polish-off";
const CHART = "<p>chart</p>";

let disposers: (() => void)[] = [];

afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  document.documentElement.removeAttribute(OFF);
  Reflect.deleteProperty(window, "webkit");
  document.body.replaceChildren();
});

/** A frame in BB's markup, drawn with its page in srcdoc. */
function addFrame(html = CHART) {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-inline-vis-frame", "");
  const frame = document.createElement("iframe");
  frame.setAttribute("srcdoc", html);
  wrapper.append(frame);
  document.body.append(wrapper);
  return frame;
}

/** Makes the page look like BB's iOS app, where react-native-webview runs it. */
function iosApp(on: boolean) {
  if (on) {
    Object.defineProperty(window, "webkit", {
      value: { messageHandlers: { ReactNativeWebView: {} } },
      configurable: true,
    });
  } else {
    Reflect.deleteProperty(window, "webkit");
  }
}

function mount() {
  const dispose = startInlineVis({ pluginId: "superhuman" });
  if (dispose !== undefined) disposers.push(dispose);
  return dispose;
}

/** The key the frame's URL carries, which its page sends back when ready. */
function keyOf(frame: HTMLIFrameElement) {
  const src = frame.getAttribute("src") ?? "";
  return new URL(src, "http://bb.test").searchParams.get("key");
}

/** A frame's page asking for its page, as the frame does when it loads. */
function ready(frame: HTMLIFrameElement, key = keyOf(frame)) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: { type: READY, key },
      source: frame.contentWindow,
    }),
  );
}

/** The messages BB posts to a frame's window. */
function listen(frame: HTMLIFrameElement) {
  const received: unknown[] = [];
  frame.contentWindow?.addEventListener("message", (e) => received.push(e.data));
  return received;
}

const settle = () => new Promise((resolve) => setTimeout(resolve));

it("leaves frames alone outside BB's iOS app", () => {
  iosApp(false);
  const frame = addFrame();
  expect(mount()).toBeUndefined();
  expect(frame.hasAttribute("srcdoc")).toBe(true);
  expect(frame.hasAttribute("src")).toBe(false);
});

it("loads a frame's page through the plugin in BB's iOS app", () => {
  iosApp(true);
  const frame = addFrame();
  mount();
  expect(frame.hasAttribute("srcdoc")).toBe(false);
  expect(frame.getAttribute("src")).toMatch(
    /^\/api\/v1\/plugins\/superhuman\/http\/inline-vis\?key=\w+$/,
  );
});

it("answers a frame's ready message with the page BB drew for it", async () => {
  iosApp(true);
  const frame = addFrame(CHART);
  mount();
  const received = listen(frame);
  ready(frame);
  await settle();
  expect(received).toEqual([{ type: PAGE, html: CHART }]);
});

it("answers only the frame whose key is in its ready message", async () => {
  iosApp(true);
  const frame = addFrame();
  mount();
  const received = listen(frame);
  ready(frame, "not-the-key");
  await settle();
  expect(received).toEqual([]);
});

it("keeps answering a frame that an earlier mount converted", async () => {
  iosApp(true);
  const frame = addFrame(CHART);
  mount()?.();
  mount();
  const received = listen(frame);
  ready(frame);
  await settle();
  expect(received).toEqual([{ type: PAGE, html: CHART }]);
});

it("puts BB's page back while UI Polish is off, and converts again once on", async () => {
  iosApp(true);
  const frame = addFrame(CHART);
  mount();
  document.documentElement.setAttribute(OFF, "");
  await settle();
  expect(frame.getAttribute("srcdoc")).toBe(CHART);
  expect(frame.hasAttribute("src")).toBe(false);
  document.documentElement.removeAttribute(OFF);
  await settle();
  expect(frame.hasAttribute("srcdoc")).toBe(false);
  expect(frame.hasAttribute("src")).toBe(true);
});

it("shows BB's new page, not the earlier one, when UI Polish is off", async () => {
  iosApp(true);
  const frame = addFrame(CHART);
  mount();
  document.documentElement.setAttribute(OFF, "");
  frame.setAttribute("srcdoc", "<p>new</p>");
  await settle();
  expect(frame.getAttribute("srcdoc")).toBe("<p>new</p>");
  expect(frame.hasAttribute("src")).toBe(false);
});

it("serves the frame page sandboxed, with the key from its URL", async () => {
  const route = vi.fn();
  registerUiPolishServer({ http: { route } } as unknown as BbPluginApi);
  expect(route.mock.calls[0].slice(0, 2)).toEqual(["GET", "/inline-vis"]);
  const handler = route.mock.calls[0][2];

  const key = "0123456789abcdef0123456789abcdef";
  const response = await handler({
    req: { query: (name: string) => (name === "key" ? key : undefined) },
  });
  expect(response.headers.get("content-security-policy")).toContain(
    "sandbox allow-scripts allow-forms",
  );
  expect(await response.text()).toContain(`key:"${key}"`);

  const hostile = await handler({
    req: { query: () => "</script><script>alert(1)</script>" },
  });
  const html = await hostile.text();
  expect(html).not.toContain("<script>alert(1)");
  expect(html).toContain('key:""');
});
