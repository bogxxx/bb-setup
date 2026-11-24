import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";

it("uses only the public SDK and package-local source", async () => {
  const result = await experimental_scanPublicSdkOnly(
    fileURLToPath(new URL(".", import.meta.url)),
    {
      allow: [
        // React, BB's toasts, zod, and the vendored components' libraries.
        /^(react|react-dom|sonner|zod|clsx|tailwind-merge|class-variance-authority)$/,
        /^@radix-ui\/react-alert-dialog$/,
        /^@testing-library\//,
      ],
    },
  );
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
