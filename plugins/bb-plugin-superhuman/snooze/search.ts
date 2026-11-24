// BB's title match for thread search: every query token starts a word of the
// title, ignoring case and diacritics, with BB's highlight ranges.

export type Range = { start: number; end: number };

const WORD = /[\p{L}\p{N}]+/gu;

const normalize = (value: string) =>
  value.normalize("NFD").replace(/\p{Mark}/gu, "").toLocaleLowerCase();

/**
 * Where `text` matches the first of `queries` whose every token starts one of
 * its words, or null when none does.
 */
export function matchTitle(text: string, queries: string[]): Range[] | null {
  const words = normalize(text).match(WORD) ?? [];
  for (const query of queries) {
    const found = Array.from(query.matchAll(WORD), ([token]) => token);
    const tokens = [...new Set(found.map(normalize))];
    if (
      tokens.length > 0 &&
      tokens.every((token) => words.some((word) => word.startsWith(token)))
    ) {
      return highlight(text, tokens);
    }
  }
  return null;
}

function highlight(text: string, tokens: string[]): Range[] {
  // Each normalized UTF-16 unit maps back to the code point it came from.
  let normal = "";
  const origin: Range[] = [];
  let start = 0;
  for (const char of text) {
    const value = normalize(char);
    normal += value;
    for (let i = 0; i < value.length; i++) {
      origin.push({ start, end: start + char.length });
    }
    start += char.length;
  }
  const ranges: Range[] = [];
  for (const token of tokens) {
    let at = normal.indexOf(token);
    while (at !== -1) {
      ranges.push({
        start: origin[at]!.start,
        end: origin[at + token.length - 1]!.end,
      });
      at = normal.indexOf(token, at + token.length);
    }
  }
  ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous === undefined || range.start > previous.end) {
      merged.push(range);
    } else {
      previous.end = Math.max(previous.end, range.end);
    }
  }
  // BB returns at most eight.
  return merged.slice(0, 8);
}
