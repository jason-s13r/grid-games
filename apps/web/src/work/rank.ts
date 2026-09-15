// The page's end of the ranking worker.
//
// A promise rather than the callback object the replay session uses, and the
// difference is real: a replay is a thing with a middle worth watching, and a
// ranking is one answer that takes a while to arrive. The worker is started per
// request and terminated when the answer lands, because there is no state in it
// worth keeping between tables.

import type { ArchivedGame, Leaderboard } from "@tessera/net";
import type { FromWorker } from "./worker";

export function rankInWorker(
  games: ArchivedGame[],
  make: () => Worker = () =>
    new Worker(new URL("./worker.ts", import.meta.url), { type: "module" }),
): Promise<Leaderboard> {
  return new Promise((resolve, reject) => {
    const worker = make();
    const done = (): void => worker.terminate();
    worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      done();
      if (event.data.k === "table") return resolve(event.data.board);
      reject(new Error(event.data.k === "failed" ? event.data.problem : "unexpected answer"));
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      done();
      reject(new Error(event.message || "the ranking engine stopped"));
    });
    worker.postMessage({ k: "rank", games });
  });
}
