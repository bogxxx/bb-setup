import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { insideHasSelectors } from "./has-selectors";

describe("insideHasSelectors", () => {
  it("finds an element's inside styled by what it holds", () => {
    expect(insideHasSelectors("a:has(b) c { color: red }")).toEqual(["a:has(b) c"]);
    expect(insideHasSelectors("a:not(:has(> b)) > c {}")).toEqual(["a:not(:has(> b)) > c"]);
    expect(insideHasSelectors("x { a:has(b) { > c { color: red } } }")).toEqual([":is(:is(x) a:has(b)) > c"]);
    expect(insideHasSelectors(":is(a:has(b) c, d) e {}")).toHaveLength(1);
    expect(insideHasSelectors("@media (width < 48rem) { a:has(b) c {} }")).toHaveLength(1);
  });

  it("passes a :has() on the styled element, before a sibling, or read through a style query", () => {
    expect(insideHasSelectors(`
      a:has(b) { --mark: 1; content: "a:has(b) c {"; }
      a:has(b) + c, a:has(b) ~ c {}
      @container style(--mark: 1) { a c { color: red } }
      x { :is(a, b) { > c:has(d) {} } }
    `)).toEqual([]);
  });
});

it("keeps every stylesheet of the plugin free of them", () => {
  // The plugin's own stylesheets, also in an export without git.
  const files = readdirSync(`${__dirname}/..`, { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".css") && !/^(node_modules|dist)\//.test(file));
  expect(files.length).toBeGreaterThan(0);
  const found = files.flatMap((file) =>
    insideHasSelectors(readFileSync(`${__dirname}/../${file}`, "utf8")).map((selector) => `${file}: ${selector}`));
  expect(found).toEqual([]);
});
