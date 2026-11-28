import { describe, expect, test } from "bun:test";
import { fitEffort, fitLevel, type CatalogModel } from "../lib/effort";

// Catalog order is not rank order, as the live catalog lists them.
const OPUS = ["low", "medium", "high", "xhigh", "ultracode", "max"];
const CODEX = ["low", "medium", "high", "xhigh", "max", "ultra"];

function entry(id: string, levels: string[], isDefault = false): CatalogModel {
  return { id, model: id, isDefault, supportedReasoningEfforts: levels.map((reasoningEffort) => ({ reasoningEffort })) };
}

describe("fitLevel", () => {
  test("a listed level is kept", () => {
    expect(fitLevel("xhigh", OPUS)).toBe("xhigh");
  });

  test("ultra and ultracode swap for each other", () => {
    expect(fitLevel("ultra", OPUS)).toBe("ultracode");
    expect(fitLevel("ultracode", CODEX)).toBe("ultra");
  });

  test("a level above the list clamps down to the highest listed below it", () => {
    expect(fitLevel("max", ["low", "medium", "high"])).toBe("high");
  });

  test("a level below the list clamps up to the lowest listed", () => {
    expect(fitLevel("low", ["medium", "high"])).toBe("medium");
  });

  test("with no listed level of known rank, the request passes through", () => {
    expect(fitLevel("xhigh", [])).toBe("xhigh");
    expect(fitLevel("xhigh", ["foo"])).toBe("xhigh");
  });
});

describe("fitEffort without Copilot suffixes", () => {
  const catalog = [entry("claude-opus-5-5", OPUS, true), entry("gpt-6.1-sol", CODEX)];

  test("keeps the model and fits the level to the listed ones", () => {
    expect(fitEffort({ model: "claude-opus-5-5", reasoningLevel: "medium" }, "xhigh", catalog, { suffixed: false })).toEqual({
      model: "claude-opus-5-5",
      reasoningLevel: "xhigh",
    });
  });

  test("a model the catalog does not list passes the request through", () => {
    expect(fitEffort({ model: "gemini-4-argon", reasoningLevel: "medium" }, "xhigh", catalog, { suffixed: false })).toEqual({
      model: "gemini-4-argon",
      reasoningLevel: "xhigh",
    });
  });

  test("a listed model with no levels passes the request through", () => {
    expect(fitEffort({ model: "claude-opus-5-5", reasoningLevel: "medium" }, "high", [entry("claude-opus-5-5", [])], { suffixed: false })).toEqual({
      model: "claude-opus-5-5",
      reasoningLevel: "high",
    });
  });

  test("no catalog passes the request through", () => {
    expect(fitEffort({ model: "claude-opus-5-5", reasoningLevel: "medium" }, "xhigh", null, { suffixed: false })).toEqual({
      model: "claude-opus-5-5",
      reasoningLevel: "xhigh",
    });
  });

  test("a spec with no model fits against the catalog's default model", () => {
    const fitted = fitEffort({ reasoningLevel: "medium" }, "xhigh", [entry("a", ["low"]), entry("b", ["medium", "high"], true)], { suffixed: false });
    expect(fitted).toEqual({ model: undefined, reasoningLevel: "high" });
  });
});

describe("fitEffort with Copilot suffixed ids", () => {
  const suffixed = { suffixed: true };

  test("the id swaps to the listed level's id", () => {
    const catalog = [entry("claude-opus-5.5-low", []), entry("claude-opus-5.5-medium", []), entry("claude-opus-5.5-xhigh", [])];
    expect(fitEffort({ model: "claude-opus-5.5-medium", reasoningLevel: "medium" }, "xhigh", catalog, suffixed)).toEqual({
      model: "claude-opus-5.5-xhigh",
      reasoningLevel: "xhigh",
    });
  });

  test("a level above the listed ids clamps to the highest listed id", () => {
    const catalog = [entry("gpt-6.1-sol-low", []), entry("gpt-6.1-sol-medium", []), entry("gpt-6.1-sol-high", [])];
    expect(fitEffort({ model: "gpt-6.1-sol-medium", reasoningLevel: "medium" }, "xhigh", catalog, suffixed)).toEqual({
      model: "gpt-6.1-sol-high",
      reasoningLevel: "high",
    });
  });

  test("a null catalog or no listed id of that model keeps the pin", () => {
    const pin = { model: "gpt-6.1-sol-medium", reasoningLevel: "medium" };
    expect(fitEffort(pin, "xhigh", null, suffixed)).toEqual(pin);
    expect(fitEffort(pin, "xhigh", [entry("claude-opus-5.5-xhigh", [])], suffixed)).toEqual(pin);
  });

  test("-standard ids are never chosen", () => {
    const catalog = [entry("gpt-6.1-sol-standard-xhigh", []), entry("gpt-6.1-sol-medium", [])];
    expect(fitEffort({ model: "gpt-6.1-sol-medium", reasoningLevel: "medium" }, "xhigh", catalog, suffixed)).toEqual({
      model: "gpt-6.1-sol-medium",
      reasoningLevel: "medium",
    });
  });
});

describe("fitEffort with an unreadable request", () => {
  const pin = { model: "claude-opus-5-5", reasoningLevel: "medium" };
  const catalog = [entry("claude-opus-5-5", OPUS, true)];

  test.each([null, undefined, "", "default"])("%p keeps the pin", (requested) => {
    expect(fitEffort(pin, requested, catalog, { suffixed: false })).toEqual(pin);
    expect(fitEffort(pin, requested, catalog, { suffixed: true })).toEqual(pin);
  });
});
