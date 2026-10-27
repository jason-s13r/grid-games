// Every recorded game this build must still reproduce, one per supported
// version.
//
// An explicit list rather than a glob: this file is loaded by two runners —
// Node under `packages/sim`, and Chromium, Firefox and WebKit under
// `apps/web/vitest.config.ts` — and one line per version is cheaper than
// depending on glob semantics agreeing across both.
//
// Adding a version means recording its fixture and adding it here. Retiring
// one means deleting both, and `protocols.test.ts` is what tells you which.

import type { Genesis, Move } from "../../types.js";
import v3 from "./recorded-v3.json";
import v4 from "./recorded-v4.json";

export interface Recorded {
  note: string;
  genesis: Genesis;
  steps: number;
  hash: string;
  moveLog: Move[];
}

export const RECORDED = [v4, v3] as unknown as Recorded[];
