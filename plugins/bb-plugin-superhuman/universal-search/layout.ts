import { defaultFilter } from "cmdk";

// US QWERTY and Russian ЙЦУКЕН positions, including their punctuation keys.
const latin =
  "`qwertyuiop[]asdfghjkl;'zxcvbnm,." + '~QWERTYUIOP{}ASDFGHJKL:"ZXCVBNM<>';
const russian =
  "ёйцукенгшщзхъфывапролджэячсмитьбю" + "ЁЙЦУКЕНГШЩЗХЪФЫВАПРОЛДЖЭЯЧСМИТЬБЮ";

/** Preserve the real query and add one interpretation in the other layout. */
export function alternateQuery(query: string): string | null {
  if (!/[a-zа-яё]/i.test(query)) return null;
  const [from, to] = /[а-яё]/i.test(query) ? [russian, latin] : [latin, russian];
  const alternative = [...query].map((char) => to[from.indexOf(char)] ?? char).join("");
  return alternative === query ? null : alternative;
}

export const layoutFilter: typeof defaultFilter = (value, query, keywords) => {
  const original = defaultFilter(value, query, keywords);
  const alternate = alternateQuery(query);
  return alternate === null
    ? original
    : Math.max(original, defaultFilter(value, alternate, keywords));
};
