// Two suites, two engines.
//
// The client's own tests are pure logic and run under Node like every other
// package's. The second project exists for one file: the cross-environment
// determinism check, which has to run in a real browser to mean anything.
//
// It lives in packages/sim and is reached from here rather than copied, so
// there is exactly one recorded game and one set of assertions about it. This
// package is simply where a browser can be launched from — the client is the
// only thing here that ships to one.
//
// A third project since: the views that build markup as strings, checked
// against a real DOM. One engine, because that is a question about the HTML
// parser and not about arithmetic.
//
// Three browsers rather than one, because a single engine proves less than it
// looks: Chromium and Node are both V8, so that pairing catches a bundler or
// environment difference and never an engine one. WebKit and Firefox are the
// ones that would actually disagree about a float or an iteration order, which
// is the hazard the sim is written to avoid.

import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import shared from "../../vitest.shared";

const crossEnv = fileURLToPath(
  new URL("../../packages/sim/src/test/crossenv.test.ts", import.meta.url),
);

/** Headless everywhere. Set BROWSERS to narrow it — `BROWSERS=chromium` is the
 *  fast loop while working on something, all three are what CI runs. */
const browsers = (process.env.BROWSERS ?? "chromium,firefox,webkit").split(",");

export default defineConfig({
  ...shared,
  test: {
    ...shared.test,
    projects: [
      {
        ...shared,
        test: {
          ...shared.test,
          name: "node",
          include: ["src/test/**/*.test.ts"],
          // The `.browser.` files are in that glob too, and they want a DOM.
          exclude: [...(shared.test?.exclude ?? []), "src/test/**/*.browser.test.ts"],
        },
      },
      {
        ...shared,
        test: {
          ...shared.test,
          name: "ui",
          // The client's views build markup as strings, and a string a browser
          // refuses to parse the way it was meant is a bug no Node test can
          // see. One engine is enough for that: this is about the HTML parser
          // and the DOM, which the three agree about — unlike a float, which is
          // what the sweep below exists for.
          include: ["src/test/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            provider: "playwright",
            headless: true,
            instances: [{ browser: "chromium" }],
          },
        },
      },
      {
        ...shared,
        test: {
          ...shared.test,
          name: "browser",
          include: [crossEnv],
          browser: {
            enabled: true,
            provider: "playwright",
            headless: true,
            instances: browsers.map((browser) => ({ browser })),
          },
        },
      },
    ],
  },
});
