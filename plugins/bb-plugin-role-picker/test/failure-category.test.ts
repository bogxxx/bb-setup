import { describe, expect, test } from "bun:test";
import { ACCOUNT_CATEGORIES, QUOTA_CATEGORIES } from "../lib/quota-block";

describe("failure categories", () => {
  test("permission_denied is a quota failure that blocks the whole provider", () => {
    expect(QUOTA_CATEGORIES.has("permission_denied")).toBe(true);
    expect(ACCOUNT_CATEGORIES.has("permission_denied")).toBe(true);
  });

  test("rate-limit blocks only the model", () => {
    expect(QUOTA_CATEGORIES.has("rate-limit")).toBe(true);
    expect(ACCOUNT_CATEGORIES.has("rate-limit")).toBe(false);
  });
});
