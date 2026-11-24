import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PAGE, READY } from "./inline-vis";

// The page an inline-vis frame loads in BB's iOS app (see inline-vis.ts): it
// asks the BB page, with the key from its own URL, for the page BB would have
// put in the frame, and shows it. Like BB's frame, it runs sandboxed, apart
// from BB's origin.
function framePage(key: string) {
  return `<!doctype html><meta charset="utf-8"><script>addEventListener("message",function show(e){var d=e.data;if(e.source!==parent||!d||d.type!==${JSON.stringify(PAGE)}||typeof d.html!=="string")return;removeEventListener("message",show);document.open();document.write(d.html);document.close()});parent.postMessage({type:${JSON.stringify(READY)},key:${JSON.stringify(key)}},"*")</script>`;
}

export default function registerUiPolishServer(bb: BbPluginApi) {
  bb.http.route("GET", "/inline-vis", (c) => {
    // The key is the 32 hex digits inline-vis.ts makes. Anything else is dropped,
    // since the key lands inside a script.
    const raw = c.req.query("key") ?? "";
    const key = /^[0-9a-f]{32}$/.test(raw) ? raw : "";
    return new Response(framePage(key), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "sandbox allow-scripts allow-forms; frame-ancestors 'self'",
        "x-content-type-options": "nosniff",
        "cache-control": "no-cache",
      },
    });
  });
}
