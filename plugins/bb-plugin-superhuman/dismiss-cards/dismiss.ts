import { changedOutside, LIVE_OUTPUT } from "../lib/mutations";

// BB's cards above a thread's message box, by label, with the kind each is
// saved as: background work, child threads, and the parent thread, pull
// request and changed files. The background card's label names what runs, so
// its three labels share one kind.
const KINDS: Record<string, string> = {
  "Background activity": "background",
  "Background agents": "background",
  "Background commands": "background",
  "Child threads": "children",
  "Thread context before sending": "context",
};
const CARD = Object.keys(KINDS)
  .map((label) => `[data-app-composer] section[aria-label="${label}"]`)
  .join(", ");
const THREAD = /\/threads\/(thr_\w+)/;
const HIDDEN = "data-superhuman-dismissed";
const BUTTON = "superhuman-card-close";
const STORE = "superhuman:dismissed-cards";
// Cards hidden at most; the oldest come back first.
const LIMIT = 200;

/** Each hidden card's words, by its thread and kind. */
let hidden: Record<string, string> = {};

/** The hidden cards as saved, with those hidden in other tabs since. */
function load(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "{}");
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

/**
 * Gives each card a close button, until the returned function runs. A hidden
 * card stays hidden in its thread until its words change; a new count or
 * running time doesn't bring it back.
 */
export function startCardDismiss(doc: Document): () => void {
  hidden = load();
  const observer = new MutationObserver((records) => {
    if (changedOutside(records, LIVE_OUTPUT)) sync(doc);
  });
  observer.observe(doc.body, {
    childList: true,
    characterData: true,
    subtree: true,
  });
  sync(doc);
  return () => {
    observer.disconnect();
    doc.querySelectorAll(`.${BUTTON}`).forEach((button) => button.remove());
    doc.querySelectorAll(`[${HIDDEN}]`).forEach((card) =>
      card.removeAttribute(HIDDEN));
  };
}

function sync(doc: Document) {
  for (const card of doc.querySelectorAll(CARD)) {
    const found = describe(card);
    if (!found) continue;
    card.toggleAttribute(HIDDEN, hidden[found.key] === found.words);
    // BB may add its own parts after the button; the button stays last.
    const button =
      found.header.querySelector(`:scope > .${BUTTON}`) ?? closeButton(card);
    if (button !== found.header.lastElementChild) found.header.append(button);
  }
}

/** The card's top row, with the key and words it is saved under. */
function describe(card: Element) {
  const thread = card.ownerDocument.location.pathname.match(THREAD)?.[1];
  const header = card.firstElementChild;
  const label = card.getAttribute("aria-label") ?? "";
  if (!thread || !header) return null;
  return {
    header,
    key: `${thread} ${KINDS[label]}`,
    words: words(header, label),
  };
}

function words(header: Element, label: string) {
  // The background card's top row reads otherwise as the card narrows, as it
  // does to nothing once hidden, and with each count and running time; its
  // label tells only what kind of work runs.
  if (KINDS[label] === "background") return label;
  // A count, and the plural it brings, as in "1 file" and "2 files".
  return (header.textContent ?? "")
    .replace(/\d+/g, "#")
    .replace(/(# \p{L}+?)s\b/gu, "$1");
}

function closeButton(card: Element) {
  const button = card.ownerDocument.createElement("button");
  button.type = "button";
  button.className = BUTTON;
  button.setAttribute("aria-label", "Hide card");
  button.title = "Hide until it changes";
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6 6 18M18 18 6 6" stroke="currentColor" stroke-linecap="round" stroke-width="1.5"/></svg>';
  button.addEventListener("click", () => {
    const found = describe(card);
    if (!found) return;
    hidden = load();
    delete hidden[found.key]; // Set again, so it counts as the newest.
    hidden[found.key] = found.words;
    hidden = Object.fromEntries(Object.entries(hidden).slice(-LIMIT));
    localStorage.setItem(STORE, JSON.stringify(hidden));
    card.toggleAttribute(HIDDEN, true);
  });
  return button;
}
