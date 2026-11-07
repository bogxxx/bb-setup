import { describe, expect, test } from "bun:test";
import { defaultSourceHostId } from "../lib/utils";

describe("default source host", () => {
  test("uses the source marked default", () => {
    expect(
      defaultSourceHostId([
        { isDefault: false, hostId: "host_other" },
        { isDefault: true, hostId: "host_default" },
      ]),
    ).toBe("host_default");
  });

  test("returns undefined when no source is default", () => {
    expect(defaultSourceHostId([{ isDefault: false, hostId: "host_other" }])).toBeUndefined();
  });

  test("returns undefined for an empty list", () => {
    expect(defaultSourceHostId([])).toBeUndefined();
  });
});
