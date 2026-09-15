// The page's end of the replay worker.
//
// One object with a lifetime: it starts a worker, reports what the worker says,
// and dies. Callbacks rather than promises because the interesting part is the
// middle — a build that takes a minute is a bar moving, not a value arriving —
// and a promise that resolves after "the timeline is ready" would leave the
// progress reporting to a second mechanism beside it.

import type { ArchivedGame, Verdict } from "@tessera/net";
import type { Frame } from "./Engine";
import type { FromWorker, ToWorker } from "../work/worker";

export interface SessionHandlers {
  /** What the log turned out to be. Arrives before any timeline is built, and
   *  for a bad archive it is the last thing that arrives. */
  checked: (verdict: Verdict) => void;
  building: (step: number, total: number) => void;
  /** The timeline is built and the state at step zero is in hand. */
  ready: (total: number, frame: Frame) => void;
  /** The answer to a seek. */
  at: (frame: Frame) => void;
  failed: (problem: string) => void;
}

export class ReplaySession {
  private worker: Worker | undefined;

  constructor(
    game: ArchivedGame,
    private readonly handlers: SessionHandlers,
    /** Injected by the one test that can run a worker; the page never passes
     *  it. A `new URL(..., import.meta.url)` is how the bundler is told there is
     *  a second entry point here, so it cannot be built from a string. */
    make: () => Worker = () =>
      new Worker(new URL("../work/worker.ts", import.meta.url), { type: "module" }),
  ) {
    this.worker = make();
    this.worker.addEventListener("message", (event: MessageEvent<FromWorker>) => {
      const message = event.data;
      if (message.k === "checked") return this.handlers.checked(message.verdict);
      if (message.k === "progress") return this.handlers.building(message.step, message.total);
      if (message.k === "ready") return this.handlers.ready(message.total, message.frame);
      if (message.k === "at") return this.handlers.at(message.frame);
      // `table` is the other job this worker entry does and never ours: each
      // session gets an instance of its own, so it cannot arrive here.
      if (message.k === "failed") this.handlers.failed(message.problem);
    });
    // A worker that throws on its own is still a failure the player has to be
    // told about, and it never reaches the handler above.
    this.worker.addEventListener("error", (event: ErrorEvent) =>
      this.handlers.failed(event.message || "the replay engine stopped"),
    );
    this.send({ k: "open", game });
  }

  seek(step: number): void {
    this.send({ k: "seek", step });
  }

  /** The whole of the cancel story. A worker mid-simulation cannot answer a
   *  message, so it is killed; nothing outside it has been told anything that
   *  needs unwinding. */
  close(): void {
    this.worker?.terminate();
    this.worker = undefined;
  }

  private send(message: ToWorker): void {
    this.worker?.postMessage(message);
  }
}
