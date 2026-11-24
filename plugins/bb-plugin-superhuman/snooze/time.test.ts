import { describe, expect, it } from "vitest";
import { fmtUntil, fmtWhen, lastUsed, parse, presets } from "./time";

/** A local moment in 2026, which the tests treat as this year. */
const local = (month: number, day: number, hour = 0, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

// Saturday, September 26, 2026, 2:30 PM.
const SATURDAY = local(9, 26, 14, 30);

function presetTimes(ref: number) {
  return presets(ref).map((preset) => [preset.id, preset.until]);
}

describe("presets", () => {
  it("puts Later today on the first of 9:00, 15:00 and 18:00 an hour away", () => {
    expect(presetTimes(local(9, 26, 8))).toEqual([
      ["later", local(9, 26, 9)],
      ["tomorrow", local(9, 27, 9)],
      ["nextweek", local(9, 28, 9)],
    ]);
    expect(presets(local(9, 26, 8, 30))[0]?.until).toBe(local(9, 26, 15));
    expect(presets(local(9, 26, 16, 59))[0]?.until).toBe(local(9, 26, 18));
    expect(presets(local(9, 26, 17))[0]?.until).toBe(local(9, 26, 18));
  });

  it("has no Later today after 17:00", () => {
    expect(presetTimes(local(9, 26, 17, 1))).toEqual([
      ["tomorrow", local(9, 27, 9)],
      ["nextweek", local(9, 28, 9)],
    ]);
  });

  it("keeps the upper preset when two land on the same moment", () => {
    // On Sunday, Tomorrow and Next week are both Monday 9:00.
    expect(presetTimes(local(9, 27, 10))).toEqual([
      ["later", local(9, 27, 15)],
      ["tomorrow", local(9, 28, 9)],
    ]);
  });
});

describe("parse", () => {
  it.each([
    ["8 am", local(9, 27, 8)],
    ["15:30", local(9, 26, 15, 30)],
    ["in 2 hours", local(9, 26, 16, 30)],
    ["3 days", local(9, 29, 9)],
    ["fri 3pm", local(10, 2, 15)],
    ["Fri, 3 PM", local(10, 2, 15)],
    ["next mon", local(9, 28, 9)],
    ["aug 7", local(8, 7, 9, 0, 2027)],
    ["7th of august", local(8, 7, 9, 0, 2027)],
    ["tomorrow evening", local(9, 27, 18)],
    ["eod", local(9, 26, 17)],
    ["2 weeks", local(10, 10, 9)],
    ["1 month", local(10, 26, 9)],
    ["tomorrow", local(9, 27, 9)],
    ["2026-10-01", local(10, 1, 9)],
  ])("reads %j", (text, expected) => {
    expect(parse(text, SATURDAY)).toBe(expected);
  });

  it.each([
    ["1", local(9, 27, 13)],
    ["6", local(9, 26, 18)],
    ["7", local(9, 27, 7)],
    ["11", local(9, 27, 11)],
    ["12", local(9, 27, 12)],
    ["0", local(9, 27, 0)],
    ["13", local(9, 27, 13)],
    ["23", local(9, 26, 23)],
  ])("reads the bare hour %j", (text, expected) => {
    expect(parse(text, SATURDAY)).toBe(expected);
  });

  it.each([
    ["morning", local(9, 27, 9)],
    ["afternoon", local(9, 26, 15)],
    ["evening", local(9, 26, 18)],
    ["night", local(9, 26, 20)],
    ["noon", local(9, 27, 12)],
    ["midnight", local(9, 27, 0)],
  ])("reads the named time %j", (text, expected) => {
    expect(parse(text, SATURDAY)).toBe(expected);
  });

  it("reads today as Later today", () => {
    expect(parse("today", SATURDAY)).toBe(local(9, 26, 18));
    expect(parse("today", local(9, 26, 17, 30))).toBeNull();
  });

  it.each(["", "foo", "8 foo", "25", "12:60", "feb 30", "3 days 2 hours"])(
    "rejects %j",
    (text) => {
      expect(parse(text, SATURDAY)).toBeNull();
    },
  );
});

describe("formatting", () => {
  it("shows a row's time with the year only when it isn't this year", () => {
    expect(fmtWhen(local(9, 26, 17, 30), SATURDAY)).toBe("Today, 5:30 PM");
    expect(fmtWhen(local(9, 27, 9), SATURDAY)).toBe("Sun, Sep 27, 9:00 AM");
    expect(fmtWhen(local(1, 4, 0, 5, 2027), SATURDAY)).toBe(
      "Mon, Jan 4, 2027, 12:05 AM",
    );
  });

  it("says until when", () => {
    expect(fmtUntil(local(9, 26, 18), SATURDAY)).toBe("today at 6:00 PM");
    expect(fmtUntil(local(9, 27, 9), SATURDAY)).toBe("tomorrow at 9:00 AM");
    expect(fmtUntil(local(9, 28, 9), SATURDAY)).toBe("Mon, Sep 28 at 9:00 AM");
  });
});

describe("lastUsed", () => {
  it("recomputes a typed choice from now", () => {
    const choice = { kind: "text", text: "fri 3pm" } as const;
    expect(lastUsed(choice, SATURDAY)).toBe(local(10, 2, 15));
    expect(lastUsed(choice, local(10, 3, 10))).toBe(local(10, 9, 15));
  });

  it("recomputes a preset and hides it when it has no time now", () => {
    const choice = { kind: "preset", id: "later" } as const;
    expect(lastUsed(choice, SATURDAY)).toBe(local(9, 26, 18));
    expect(lastUsed(choice, local(9, 26, 17, 30))).toBeNull();
    expect(lastUsed(null, SATURDAY)).toBeNull();
  });
});
