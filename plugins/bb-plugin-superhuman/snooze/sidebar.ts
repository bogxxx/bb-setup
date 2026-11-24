/** Thread ids in sidebar order, read from the DOM as BB's Next thread does. */
export function sidebarThreadIds(): string[] {
  const ids: string[] = [];
  const elements = document.querySelectorAll<HTMLElement>(
    "[data-sidebar-thread-shortcut-target], [data-sidebar-windowed-nav]",
  );
  for (const element of elements) {
    if (element.closest("[data-sidebar-overflow='true']")) continue;
    // Rows in a collapsed group stay in the DOM; BB skips them too.
    if (element.checkVisibility?.({ visibilityProperty: true }) === false) {
      continue;
    }
    if (element instanceof HTMLAnchorElement) {
      if (element.dataset.sidebarThreadId) {
        ids.push(element.dataset.sidebarThreadId);
      }
      continue;
    }
    // A windowed stretch of rows lists its threads as "threadId:projectId".
    const encoded = element.getAttribute("data-sidebar-windowed-nav") ?? "";
    for (const pair of encoded.split(" ")) {
      const separator = pair.indexOf(":");
      if (separator > 0 && separator < pair.length - 1) {
        ids.push(pair.slice(0, separator));
      }
    }
  }
  return ids;
}

/**
 * The thread to open once `threadId` and the threads hidden with it leave the
 * sidebar: the next one down, or after the last one the nearest one above.
 */
export function nextThread(
  order: string[],
  threadId: string,
  hidden: string[],
): string | null {
  const index = order.indexOf(threadId);
  const shown = (id: string) => !hidden.includes(id);
  return (
    order.slice(index + 1).find(shown) ??
    order.slice(0, Math.max(index, 0)).reverse().find(shown) ??
    null
  );
}
