// One Vitest configuration, shared by every package.
//
// The aliases are the point. Each package's manifest sends `@tessera/sim` and
// friends to `dist`, which would put a full `tsc` in front of every test run —
// exactly what moving off the hand-rolled runner was meant to remove. Pointing
// them at the TypeScript source instead means a test run compiles nothing:
// Vitest transforms what it loads, and a failure's stack lands on the line you
// are about to edit rather than on generated output.
//
// Paths resolve against this file, not the importing config, so every package
// gets the same three aliases regardless of where it sits.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tessera/sim": source("sim"),
      "@tessera/protocol": source("protocol"),
      "@tessera/net": source("net"),
    },
  },
  test: {
    // These suites drive whole games — six drivers, hundreds of simulated
    // steps, real ECDSA. The default five seconds is not enough for them.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
