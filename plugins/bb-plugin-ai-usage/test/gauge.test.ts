// Every quota row reads one scale, remaining: the bar fills with % left, and the
// forecast reads % left at reset, or that the window runs out before reset.
import { describe, expect, test } from "bun:test";
import demoTeam from "../demo/team.json" with { type: "json" };
import { barPercent, barState, forecastLine, known, left, percentLeft } from "../src/format";
import { readReport, type Window } from "../src/report";

const win = (over: Partial<Window>): Window => ({
  name: "7d",
  percent: 0,
  resets_at: null,
  minutes: 10080,
  main: true,
  limits: true,
  stale: false,
  reset: false,
  unread: null,
  state: "ok",
  forecast: null,
  ...over,
});

const forecast = (percent: number, stopped = false) => ({ percent, elapsed: 0.5, runs_out_at: null, basis: "window", pace: null, stopped });

describe("bar", () => {
  test("fills with % left and takes its colour from state", () => {
    const w = win({ percent: 17, state: "ok" });
    expect(barPercent(w)).toBe(83);
    expect(barState(w)).toBe("ok");
    expect(left(w)).toBe("83%");
  });

  test("uses the same flooring as the headline", () => {
    expect(barPercent(win({ percent: 99.4 }))).toBe(1);
    expect(left(win({ percent: 99.4 }))).toBe("1%");
  });

  test("an overspent window is empty", () => {
    expect(barPercent(win({ percent: 120, state: "over" }))).toBe(0);
  });

  test("an unknown window is an empty, unknown bar", () => {
    for (const w of [win({ reset: true }), win({ unread: true }), undefined]) {
      expect(barPercent(w)).toBe(0);
      expect(barState(w)).toBe("unknown");
    }
  });

  test("a stale but known window keeps its % left", () => {
    const w = win({ percent: 40, stale: true, state: "tight" });
    expect(barPercent(w)).toBe(60);
    expect(barState(w)).toBe("tight");
  });

  test("for every demo window that is known, the bar is the headline figure", () => {
    const report = readReport(structuredClone(demoTeam));
    let checked = 0;
    for (const p of report.team.providers) {
      for (const a of p.accounts) {
        for (const w of a.quota?.windows ?? []) {
          if (!known(w)) continue;
          checked++;
          expect(left(w).replace("~", "")).toBe(`${barPercent(w)}%`);
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe("forecast", () => {
  test("no forecast, no line", () => {
    expect(forecastLine(win({ forecast: null }))).toBeNull();
  });

  test("reads % left at reset", () => {
    expect(forecastLine(win({ percent: 58, forecast: forecast(58) }))).toBe("42% left at reset · this week's pace");
  });

  test("a window projected to end at 0% left reads 0% left, not a negative", () => {
    expect(forecastLine(win({ percent: 0, forecast: forecast(0) }))).toBe("100% left at reset · this week's pace");
  });

  test("a projection past 100% used says it runs out before reset", () => {
    const line = forecastLine(win({ percent: 58, forecast: forecast(113) }));
    expect(line).toBe("runs out before reset · this week's pace");
    expect(line).not.toContain("-");
  });

  test("exactly 100% used runs out before reset", () => {
    expect(forecastLine(win({ percent: 50, forecast: forecast(100) }))).toBe("runs out before reset · this week's pace");
  });

  test("a stopped forecast past 100% used says it would run out", () => {
    expect(forecastLine(win({ percent: 50, forecast: forecast(108, true) }))).toBe("would run out before reset · this week's pace");
  });

  test("a stopped forecast under 100% used says it would have that much left", () => {
    expect(forecastLine(win({ percent: 20, forecast: forecast(60, true) }))).toBe("would have 40% left at reset · this week's pace");
  });

  test("a window already at 0% left shows no forecast line", () => {
    expect(forecastLine(win({ percent: 100, forecast: forecast(164) }))).toBeNull();
    expect(forecastLine(win({ percent: 120, forecast: forecast(164, true) }))).toBeNull();
  });

  test("no demo forecast shows a negative or a remaining above 100%", () => {
    const report = readReport(structuredClone(demoTeam));
    for (const p of report.team.providers) {
      for (const a of p.accounts) {
        for (const w of a.quota?.windows ?? []) {
          const line = forecastLine(w);
          if (line === null) continue;
          expect(line).not.toMatch(/-\d/);
          const left = /(\d+)% left/.exec(line);
          if (left !== null) expect(Number(left[1])).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

describe("edge inputs", () => {
  test("a projection just under 100% used is not an exhaustion", () => {
    expect(forecastLine(win({ percent: 50, forecast: forecast(99.4) }))).toBe("1% left at reset · this week's pace");
    expect(forecastLine(win({ percent: 50, forecast: forecast(99.6) }))).toBe("0% left at reset · this week's pace");
    expect(forecastLine(win({ percent: 50, forecast: forecast(99.6, true) }))).toBe("would have 0% left at reset · this week's pace");
  });

  test("exactly 100% used still runs out", () => {
    expect(forecastLine(win({ percent: 50, forecast: forecast(100.0) }))).toBe("runs out before reset · this week's pace");
  });

  test("a negative window reading is 100% left, and the bar agrees with the headline", () => {
    for (const percent of [-1, -0.5]) {
      const w = win({ percent });
      expect(percentLeft(w)).toBe(100);
      expect(left(w)).toBe("100%");
      expect(barPercent(w)).toBe(100);
    }
  });

  test("a negative forecast reads at most 100% left", () => {
    expect(forecastLine(win({ percent: 10, forecast: forecast(-1) }))).toBe("100% left at reset · this week's pace");
    expect(forecastLine(win({ percent: 10, forecast: forecast(-0.5, true) }))).toBe("would have 100% left at reset · this week's pace");
  });
});
