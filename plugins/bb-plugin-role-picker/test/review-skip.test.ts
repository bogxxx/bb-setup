import { describe, expect, test } from "bun:test";
import { resolveReviewHostId, usageLimitsQuery, usageSkip, type ReviewHostDeps } from "../lib/review-skip";

function deps(overrides: Partial<ReviewHostDeps> = {}): ReviewHostDeps {
  return {
    getEnvironment: async () => ({ hostId: "host_env" }),
    getProject: async () => ({
      sources: [
        { hostId: "host_other", isDefault: false },
        { hostId: "host_default", isDefault: true },
      ],
    }),
    ...overrides,
  };
}

describe("resolveReviewHostId", () => {
  test("an environment id returns that environment's host", async () => {
    const host = await resolveReviewHostId(
      { environmentId: "env_1", projectId: "proj_1" },
      deps({
        getProject: async () => {
          throw new Error("project should not be read");
        },
      }),
    );
    expect(host).toBe("host_env");
  });

  test("a null environment returns the isDefault source's host", async () => {
    const host = await resolveReviewHostId({ environmentId: null, projectId: "proj_1" }, deps());
    expect(host).toBe("host_default");
  });

  test("a project with one source and no default returns that host", async () => {
    const host = await resolveReviewHostId(
      { environmentId: null, projectId: "proj_1" },
      deps({
        getProject: async () => ({ sources: [{ hostId: "host_only", isDefault: false }] }),
      }),
    );
    expect(host).toBe("host_only");
  });

  test("a project with no default and several sources returns null", async () => {
    const host = await resolveReviewHostId(
      { environmentId: null, projectId: "proj_1" },
      deps({
        getProject: async () => ({
          sources: [
            { hostId: "host_a", isDefault: false },
            { hostId: "host_b", isDefault: false },
          ],
        }),
      }),
    );
    expect(host).toBeNull();
  });

  test("an empty environment hostId is unresolved and does not read the project", async () => {
    const host = await resolveReviewHostId(
      { environmentId: "env_1", projectId: "proj_1" },
      deps({
        getEnvironment: async () => ({ hostId: "" }),
        getProject: async () => {
          throw new Error("project should not be read");
        },
      }),
    );
    expect(host).toBeNull();
  });

  test("a default source with an empty hostId is unresolved", async () => {
    const host = await resolveReviewHostId(
      { environmentId: null, projectId: "proj_1" },
      deps({
        getProject: async () => ({
          sources: [
            { hostId: "host_other", isDefault: false },
            { hostId: "", isDefault: true },
          ],
        }),
      }),
    );
    expect(host).toBeNull();
  });

  test("a lookup that throws returns null", async () => {
    expect(
      await resolveReviewHostId(
        { environmentId: "env_1", projectId: "proj_1" },
        deps({
          getEnvironment: async () => {
            throw new Error("offline");
          },
        }),
      ),
    ).toBeNull();
    expect(
      await resolveReviewHostId(
        { environmentId: null, projectId: "proj_1" },
        deps({
          getProject: async () => {
            throw new Error("offline");
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("usageLimitsQuery", () => {
  test("forwards a resolved host and omits an unresolved one", () => {
    expect(usageLimitsQuery("acp-cursor", "host_env")).toEqual({ providerId: "acp-cursor", hostId: "host_env" });
    expect(usageLimitsQuery("acp-cursor", null)).toEqual({ providerId: "acp-cursor" });
    expect(usageLimitsQuery("acp-cursor", "")).toEqual({ providerId: "acp-cursor" });
  });
});

describe("usageSkip", () => {
  test("not_installed, unauthenticated and expired skip with a host and do not skip without one", () => {
    for (const status of ["not_installed", "unauthenticated", "expired"] as const) {
      expect(usageSkip({ status }, true)).toBe(`usage report says ${status}`);
      expect(usageSkip({ status }, false)).toBeNull();
    }
  });

  test("a window at 100 skips with or without a host, and one at 99 does not", () => {
    const full = { status: "ok", windows: [{ usedPercent: 50 }, { usedPercent: 100 }] };
    expect(usageSkip(full, true)).toBe("usage report says a window is used up");
    expect(usageSkip(full, false)).toBe("usage report says a window is used up");
    expect(usageSkip({ status: "ok", windows: [{ usedPercent: 101 }] }, false)).toBe(
      "usage report says a window is used up",
    );
    expect(usageSkip({ status: "ok", windows: [{ usedPercent: 99 }] }, true)).toBeNull();
    expect(usageSkip({ status: "ok", windows: [{ usedPercent: 99 }] }, false)).toBeNull();
  });

  test("a missing entry, error and unknown do not skip", () => {
    expect(usageSkip(undefined, true)).toBeNull();
    expect(usageSkip(null, false)).toBeNull();
    expect(usageSkip({ status: "error" }, true)).toBeNull();
    expect(usageSkip({ status: "unknown" }, true)).toBeNull();
    expect(usageSkip({ status: "error" }, false)).toBeNull();
  });

  test("a used-up window labelled with a model skips only that model", () => {
    const argon = { status: "ok", windows: [{ label: "Gemini 4 Argon weekly", usedPercent: 100 }] };
    expect(usageSkip(argon, true, "gemini-4-argon")).toBe("usage report says a window is used up");
    expect(usageSkip(argon, true, "gemini-3.8-flash")).toBeNull();
    expect(usageSkip(argon, true)).toBe("usage report says a window is used up");
  });

  test("a used-up window with no model in its label skips every model", () => {
    const weekly = { status: "ok", windows: [{ label: "Weekly", usedPercent: 100 }] };
    expect(usageSkip(weekly, true, "gemini-4-argon")).toBe("usage report says a window is used up");
    expect(usageSkip(weekly, true, "gemini-3.8-flash")).toBe("usage report says a window is used up");
  });
});
