// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { startCardDismiss } from "./dismiss";

// BB's cards above a thread's message box, as of 0.46.0, with a plugin's card.
const PAGE = `
  <div data-app-composer>
    <div>
      <div data-bb-plugin-root><section aria-label="thread-sidebar"><div></div></section></div>
      <section id="background" aria-label="Background commands">
        <div><button>Running 7 background commands</button></div>
      </section>
      <section id="context" aria-label="Thread context before sending">
        <div><a>PR #6783 · Open</a><span>1 file</span></div>
      </section>
    </div>
  </div>`;

const settle = () => new Promise((resolve) => setTimeout(resolve));
const card = (id: string) => document.getElementById(id)!;
const hidden = (id: string) => card(id).hasAttribute("data-superhuman-dismissed");
const close = (id: string) =>
  card(id).querySelector<HTMLButtonElement>(".superhuman-card-close")!;
const write = (selector: string, text: string) => {
  document.querySelector(selector)!.textContent = text;
  return settle();
};
const open = (thread: string) =>
  history.replaceState(null, "", `/projects/proj_a/threads/${thread}`);

let stop: (() => void) | undefined;

beforeEach(() => {
  // Node's own localStorage, without a file, hides jsdom's.
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  open("thr_one");
  document.body.innerHTML = PAGE;
});

afterEach(() => {
  stop?.();
  vi.unstubAllGlobals();
});

it("gives BB's cards a close button at the end of their top row", () => {
  stop = startCardDismiss(document);
  for (const id of ["background", "context"]) {
    expect(card(id).firstElementChild!.lastElementChild).toBe(close(id));
  }
  expect(document.querySelector("[data-bb-plugin-root] button")).toBeNull();
});

it("keeps a background card hidden until other work runs", async () => {
  stop = startCardDismiss(document);
  close("background").click();
  expect(hidden("background")).toBe(true);
  expect(hidden("context")).toBe(false);

  // Its row reads otherwise as it narrows; a reload keeps it hidden too.
  await write("#background button", "Running background command: sleep 5s");
  expect(hidden("background")).toBe(true);
  stop();
  stop = startCardDismiss(document);
  expect(hidden("background")).toBe(true);

  card("background").setAttribute("aria-label", "Background activity");
  await write("#background button", "Running 2 background activities");
  expect(hidden("background")).toBe(false);
});

it("keeps a card hidden through new counts until its words change", async () => {
  stop = startCardDismiss(document);
  close("context").click();
  await write("#context span", "2 files");
  expect(hidden("context")).toBe(true);
  await write("#context a", "PR #6783 · Merged");
  expect(hidden("context")).toBe(false);
});

it("hides a card only in its own thread", async () => {
  stop = startCardDismiss(document);
  close("context").click();
  open("thr_two");
  // BB draws the card again for the other thread.
  await write("#context span", "1 file");
  expect(hidden("context")).toBe(false);
  open("thr_one");
  await write("#context span", "1 file");
  expect(hidden("context")).toBe(true);
});

it("keeps the button last when BB adds to the row", async () => {
  stop = startCardDismiss(document);
  const row = card("context").firstElementChild!;
  row.append(document.createElement("button"));
  await settle();
  expect(row.lastElementChild).toBe(close("context"));
  expect(row.querySelectorAll(".superhuman-card-close")).toHaveLength(1);
});

it("leaves the cards as BB draws them once stopped", () => {
  stop = startCardDismiss(document);
  close("background").click();
  stop();
  stop = undefined;
  expect(document.querySelector(".superhuman-card-close")).toBeNull();
  expect(hidden("background")).toBe(false);
});
