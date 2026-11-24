import { describe, expect, test } from "bun:test";
import { cycleRole, isRoleShortcut, ROLE_ORDER } from "../lib/role-shortcut";

describe("cycleRole", () => {
  test("goes forward through every role and wraps", () => {
    expect(ROLE_ORDER).toEqual(["regular", "orchestrator", "interviewer"]);
    expect(cycleRole("regular", false)).toBe("orchestrator");
    expect(cycleRole("orchestrator", false)).toBe("interviewer");
    expect(cycleRole("interviewer", false)).toBe("regular");
  });
  test("goes backward with Shift", () => {
    expect(cycleRole("regular", true)).toBe("interviewer");
    expect(cycleRole("interviewer", true)).toBe("orchestrator");
  });
});

describe("isRoleShortcut", () => {
  const key = { altKey: true, ctrlKey: false, metaKey: false, code: "KeyR", repeat: false };
  test("is Alt+R by key position", () => {
    expect(isRoleShortcut(key)).toBe(true);
  });
  test("leaves other chords and held repeats alone", () => {
    expect(isRoleShortcut({ ...key, altKey: false })).toBe(false);
    expect(isRoleShortcut({ ...key, ctrlKey: true })).toBe(false);
    expect(isRoleShortcut({ ...key, metaKey: true })).toBe(false);
    expect(isRoleShortcut({ ...key, code: "KeyT" })).toBe(false);
    expect(isRoleShortcut({ ...key, repeat: true })).toBe(false);
  });
});
