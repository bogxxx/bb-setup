import { describe, expect, it } from "vitest";
import { displayStatus } from "../src/status";

describe("displayStatus", () => {
  it("maps the four BB statuses", () => {
    expect(displayStatus("pending")).toBe("in_progress");
    expect(displayStatus("completed")).toBe("finished");
    expect(displayStatus("failed")).toBe("failed");
    expect(displayStatus("interrupted")).toBe("interrupted");
  });

  it("keeps taskStatus stopped, killed, and paused from becoming a display status", () => {
    expect(displayStatus("interrupted", "stopped")).toBe("interrupted");
    expect(displayStatus("failed", "killed")).toBe("failed");
    expect(displayStatus("pending", "paused")).toBe("in_progress");
    expect(displayStatus("stopped")).toBeNull();
    expect(displayStatus("killed")).toBeNull();
    expect(displayStatus("paused")).toBeNull();
  });
});
