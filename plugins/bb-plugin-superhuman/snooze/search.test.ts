import { expect, it } from "vitest";
import { matchTitle } from "./search";

it("needs every token to start a word, and highlights each", () => {
  expect(matchTitle("Fix flaky deploy", ["flak dep"])).toEqual([
    { start: 4, end: 8 },
    { start: 10, end: 13 },
  ]);
  expect(matchTitle("Fix flaky deploy", ["flak zzz"])).toBeNull();
  expect(matchTitle("Fix flaky deploy", ["laky"])).toBeNull();
  expect(matchTitle("Fix flaky deploy", ["!!"])).toBeNull();
  expect(matchTitle("", ["fix"])).toBeNull();
});

it("ignores case and diacritics on both sides", () => {
  expect(matchTitle("Café Résumé", ["CAFE resu"])).toEqual([
    { start: 0, end: 4 },
    { start: 5, end: 9 },
  ]);
  expect(matchTitle("Cafe", ["café"])).toEqual([{ start: 0, end: 4 }]);
});

it("matches Cyrillic and the first query that matches", () => {
  expect(matchTitle("Привет мир", ["ПРИВ"])).toEqual([{ start: 0, end: 4 }]);
  expect(matchTitle("Fix flaky deploy", ["адфл", "flak"])).toEqual([
    { start: 4, end: 8 },
  ]);
});

it("merges overlapping and touching ranges, in UTF-16 indexes", () => {
  expect(matchTitle("deploy deployment", ["dep deploy"])).toEqual([
    { start: 0, end: 6 },
    { start: 7, end: 13 },
  ]);
  expect(matchTitle("abab", ["ab"])).toEqual([{ start: 0, end: 4 }]);
  expect(matchTitle("🚀 Launch", ["lau"])).toEqual([{ start: 3, end: 6 }]);
  expect(matchTitle("a ".repeat(10), ["a"])).toHaveLength(8);
});
