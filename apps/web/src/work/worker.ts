// Everything expensive, off the thread that paints.
//
// Two jobs, one worker entry, and the reason is worth writing down because the
// obvious shape — a worker per job — is the one that does not build. Both jobs
// need `@tessera/net`, so Parcel factors it into a bundle shared between them
// and loads that bundle with `importScripts`, which a module worker cannot call;
// the second worker then dies with `Cannot find module`. One entry point has no
// second worker to share with. The two sessions still get an instance each —
// they have different lifetimes, and a ranking must not be able to kill a replay
// on its way out.
//
// Glue and nothing else. Every decision is in `Engine.ts` and in
// `packages/net`, which is why those are testable under Node and this is not
// tested at all: there is nothing here to be wrong about.
//
// The page cancels by terminating. A worker in a tight simulation loop cannot
// read its own message queue, and there is nothing to unwind when it dies
// mid-build — nobody outside it has been told anything yet.

import { rankArchives } from "@tessera/net";
import type { ArchivedGame, Leaderboard, Verdict } from "@tessera/net";
import { ReplayEngine } from "../replay/Engine";
import type { Frame } from "../replay/Engine";

export type ToWorker =
  | { k: "open"; game: ArchivedGame }
  | { k: "seek"; step: number }
  | { k: "rank"; games: ArchivedGame[] };

export type FromWorker =
  | { k: "checked"; verdict: Verdict }
  | { k: "progress"; step: number; total: number }
  | { k: "ready"; total: number; ladder: number; frame: Frame }
  | { k: "at"; frame: Frame }
  | { k: "table"; board: Leaderboard }
  | { k: "failed"; problem: string };

let engine: ReplayEngine | undefined;

const post = (message: FromWorker, transfer: Transferable[] = []): void =>
  (globalThis as unknown as Worker).postMessage(message, transfer);

globalThis.addEventListener("message", (event) => {
  void handle((event as MessageEvent<ToWorker>).data);
});

async function handle(message: ToWorker): Promise<void> {
  try {
    if (message.k === "rank") {
      // `rankArchives` verifies every archive it is given, and verifying one
      // means replaying it: five three-day games is five full replays.
      return post({ k: "table", board: await rankArchives(message.games) });
    }

    if (message.k === "seek") {
      if (!engine) return;
      const frame = engine.seek(message.step);
      return post({ k: "at", frame }, [frame.data]);
    }

    // Verified before anything is built. The expensive thing here is a replay,
    // and a timeline built for a forged log is a minute spent on a lie.
    const verdict = await ReplayEngine.check(message.game);
    post({ k: "checked", verdict });
    if (!verdict.ok) return;

    engine = new ReplayEngine(message.game);
    engine.build((step, total) => post({ k: "progress", step, total }));
    const frame = engine.seek(0);
    post({ k: "ready", total: engine.reached, ladder: engine.ladder, frame }, [frame.data]);
  } catch (error) {
    post({ k: "failed", problem: (error as Error).message });
  }
}
