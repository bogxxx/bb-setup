import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses only the public SDK and package-local source", async () => {
  const result = await experimental_scanPublicSdkOnly(
    fileURLToPath(new URL(".", import.meta.url)),
    {
      allow: [
        // React, BB's toasts, and the vendored components' libraries.
        /^(react|react-dom|sonner|cmdk|clsx|tailwind-merge)$/,
        /^@radix-ui\/react-(dialog|slot)$/,
        // Tests.
        /^@testing-library\//,
      ],
    },
  );
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
