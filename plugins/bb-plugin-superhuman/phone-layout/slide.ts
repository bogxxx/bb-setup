const PHONE = "(width < 48rem) and (pointer: coarse)";
const PAGE = 'main[data-sidebar="inset"]';
const PANEL = '[data-testid="secondary-panel-shelf"]';

/**
 * Keeps the right panel, which slide.css slides in beside the page, on the
 * page's edge while BB's swipe closes it, until the returned function runs.
 */
export function startPanelSlide(doc: Document): () => void {
  const win = doc.defaultView;
  if (!win) return () => {};
  const phone = win.matchMedia(PHONE);

  // BB's swipe closes the panel by sliding the page back under it with inline
  // styles; the panel follows the page out.
  const follow = new win.MutationObserver(() => {
    const page = doc.querySelector<HTMLElement>(PAGE);
    const panel = doc.querySelector<HTMLElement>(PANEL);
    if (!page || !panel) return;
    // Wider screens keep BB's panel, which slide.css leaves alone.
    const offset = phone.matches ? page.style.translate : "";
    panel.style.transition = offset ? page.style.transition : "";
    panel.style.translate = offset ? `calc(${offset} + 100%)` : "";
  });
  // Each touch finds the page, which BB may have rendered again.
  const watch = () => {
    const page = doc.querySelector(PAGE);
    if (page) follow.observe(page, { attributes: true, attributeFilter: ["style"] });
  };

  const listen = { capture: true, passive: true };
  doc.addEventListener("touchstart", watch, listen);
  return () => {
    doc.removeEventListener("touchstart", watch, listen);
    follow.disconnect();
    const panel = doc.querySelector<HTMLElement>(PANEL);
    if (panel) panel.style.translate = panel.style.transition = "";
  };
}
