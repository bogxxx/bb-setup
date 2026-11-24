// @vitest-environment jsdom
import { expect, it } from "vitest";
import { changedOutside, LIVE_OUTPUT } from "./mutations";

it("tells changes to the page from chat and terminal output", async () => {
  document.body.innerHTML = `<nav></nav>
    <div data-timeline-row-id="t:assistant:1"><p></p></div>
    <div class="xterm"><span></span></div>`;
  const batches: boolean[] = [];
  const observer = new MutationObserver((records) =>
    batches.push(changedOutside(records, LIVE_OUTPUT)));
  observer.observe(document.body, { childList: true, subtree: true });
  const settle = () => new Promise((resolve) => setTimeout(resolve));

  document.querySelector("p")!.append("streamed");
  document.querySelector(".xterm span")!.append("output");
  await settle();
  document.querySelector("p")!.append("more");
  document.querySelector("nav")!.append("row");
  await settle();
  observer.disconnect();
  expect(batches).toEqual([false, true]);
});
