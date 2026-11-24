// BB draws an inline-vis page in an about:srcdoc frame. BB's iOS app runs BB in
// a react-native-webview, which lets a frame load only http(s) and
// about:blank, so there the frame stays blank. In the app the frame loads
// server.ts's page from this plugin instead, and that page shows BB's.

const FRAMES = "[data-inline-vis-frame] > iframe";
export const READY = "superhuman:inline-vis-ready";
export const PAGE = "superhuman:inline-vis-page";
// Set on the root while the UI Polish setting is off; app.tsx keeps it current.
const OFF = "data-superhuman-ui-polish-off";
// On a converted frame: the page BB drew for it, and the key in the frame's URL
// that its page sends back. It lives on the frame, so a new mount keeps it.
const SHOWN = "superhumanInlineVis";

type Shown = { html: string; key: string };
type Frame = HTMLIFrameElement & { [SHOWN]?: Shown };

/** In BB's iOS app, inline-vis frames load their page through the plugin. */
export function startInlineVis({ pluginId }: { pluginId: string }) {
  if (!iosApp()) return;
  const url = `/api/v1/plugins/${pluginId}/http/inline-vis`;
  const frames = () => document.querySelectorAll<Frame>(FRAMES);
  const adopt = () => {
    const off = document.documentElement.hasAttribute(OFF);
    for (const frame of frames()) {
      const shown = frame[SHOWN];
      if (off) {
        // BB's page goes back into a frame it drew earlier, unless BB has drawn
        // a new one since.
        if (shown === undefined) continue;
        delete frame[SHOWN];
        if (!frame.hasAttribute("srcdoc")) frame.srcdoc = shown.html;
        frame.removeAttribute("src");
      } else if (frame.hasAttribute("srcdoc")) {
        const key = newKey();
        frame[SHOWN] = { html: frame.srcdoc, key };
        frame.removeAttribute("srcdoc");
        frame.src = `${url}?key=${key}`;
      }
    }
  };
  // A frame asks again whenever it loads, as BB's would load its page again.
  // Only the key from the frame's own URL gets the page, so a page the frame
  // navigated to gets nothing.
  const answer = (event: MessageEvent) => {
    const { source, data } = event;
    if (!source || data?.type !== READY) return;
    const frame = [...frames()].find((f) => f.contentWindow === source);
    const shown = frame?.[SHOWN];
    if (shown === undefined || data.key !== shown.key) return;
    (source as Window).postMessage({ type: PAGE, html: shown.html }, "*");
  };
  const observer = new MutationObserver(adopt);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["srcdoc", OFF],
  });
  window.addEventListener("message", answer);
  adopt();
  return () => {
    observer.disconnect();
    window.removeEventListener("message", answer);
  };
}

/** 32 hex digits. crypto.randomUUID needs a secure context; this does not. */
function newKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** BB's iOS app: react-native-webview's message handler in a WKWebView. */
function iosApp() {
  // WebKit hides handler names from `in` and Object.keys, so read the handler.
  const page = window as {
    webkit?: { messageHandlers?: { ReactNativeWebView?: unknown } };
  };
  return page.webkit?.messageHandlers?.ReactNativeWebView !== undefined;
}
