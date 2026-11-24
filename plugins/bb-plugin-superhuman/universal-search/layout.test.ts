import { expect, it } from "vitest";
import { alternateQuery, layoutFilter } from "./layout";

it.each([
  ["ытщщяу", "snooze"],
  ["руддщ", "hello"],
  ["Ghbdtn", "Привет"],
  ["snooze", "ытщщяу"],
  ["HELLO", "РУДДЩ"],
  ["ХЕУЫЕЪ", "{TEST}"],
  ["{TEST}", "ХЕУЫЕЪ"],
  ["Привет bb", "Ghbdtn bb"],
  ["[test]", "хеуыеъ"],
  ["123 😃", null],
  ["", null],
])("interprets %s without replacing the real query", (query, expected) => {
  expect(alternateQuery(query)).toBe(expected);
});

it("matches both layouts, keywords and the real Russian query", () => {
  expect(layoutFilter("Snooze thread", "ытщщяу")).toBeGreaterThan(0);
  expect(layoutFilter("Привет мир", "ghbdtn")).toBeGreaterThan(0);
  expect(layoutFilter("Привет мир", "привет")).toBeGreaterThan(0);
  expect(layoutFilter("Settings", "ыгзу", ["Superhuman"])).toBeGreaterThan(0);
  expect(layoutFilter("Snooze thread", "completely unrelated")).toBe(0);
});
