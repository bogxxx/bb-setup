// The snapshot and live contract accept a Copilot seat's profile key, and nothing else new.
import { describe, expect, test } from "bun:test";
import { measuredUsage } from "../src/contract";

const base = { hostName: "h", user: "u", providers: [{ provider: "copilot", name: "login", plan: null, windows: [] }] };

describe("the measured usage contract", () => {
  test("a provider with or without a profile key is accepted", () => {
    expect(measuredUsage.safeParse(base).success).toBe(true);
    const seat = { hostName: "h", user: "u", providers: [{ ...base.providers[0]!, profile: "sopra" }] };
    expect(measuredUsage.safeParse(seat).success).toBe(true);
  });

  test("another unknown field on a provider is still refused", () => {
    const extra = { hostName: "h", user: "u", providers: [{ ...base.providers[0]!, seat: "sopra" }] };
    expect(measuredUsage.safeParse(extra).success).toBe(false);
  });
});
