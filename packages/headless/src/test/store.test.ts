// The archive on disk is the same archive, or it is worth nothing.
//
// Everything about verification is already settled in @tessera/net; the only
// question here is whether a directory written a record at a time and read back
// afterwards is the file the verifier would have accepted in memory. So these
// tests write a real game — real signatures, a real simulation, a real hash —
// tear the process's copy up, and hand what is on disk to the same verifier.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTROL, MEMBER, MOVE, Sim, makeGenesis, hex } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import { Identity, sealGenesis, signMove } from "@tessera/protocol";
import type { SignedMove } from "@tessera/protocol";
import { verifyArchive } from "@tessera/net";
import { FileArchive, readArchive } from "../store.js";

/** A short game one seat actually played, signed as the mesh would have signed
 *  it. Fifty steps is enough for heartbeats, a claim and a checkpoint. */
async function played(dir: string, from = 0): Promise<{ genesis: Genesis; sim: Sim }> {
  const identity = await Identity.generate();
  const genesis = await sealGenesis(
    makeGenesis({
      seed: 21,
      startedAt: 0,
      map: { width: 24, height: 24 },
      empires: [
        { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: identity.key }] },
        { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
      ],
    }),
  );

  const sim = new Sim(genesis);
  const file = new FileArchive({ dir, genesis, source: sim, from });
  await file.open();

  let seq = 0;
  for (let step = 0; step < 50; step++) {
    const moves: Move[] = [];
    const signed: SignedMove[] = [];
    if (step % 12 === 0) {
      const move: Move = {
        step,
        empire: 1,
        member: 0,
        seq: seq++,
        type: MOVE.HEARTBEAT,
        x: 0,
        y: 0,
      };
      const envelope = await signMove(identity, genesis.gameId!, move);
      moves.push(envelope.move);
      signed.push(envelope);
    }
    file.archive.applied(step, moves, signed);
    sim.advance(moves);
  }

  await file.close();
  return { genesis, sim };
}

describe("a game written to a directory", () => {
  let dir: string;
  let sim: Sim;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tessera-archive-"));
    ({ sim } = await played(dir));
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads back as the game that was played", async () => {
    const game = await readArchive(dir);
    expect(game.genesis.gameId).toBe(sim.state.genesis.gameId);
    expect(game.steps).toBe(50);
    expect(game.hash).toBe(hex(sim.hash()));
    expect(game.moveLog.length).toBeGreaterThan(0);
  });

  it("and verifies, signatures and hash both", async () => {
    const verdict = await verifyArchive(await readArchive(dir));
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.verified).toBe(verdict.moves);
  });

  it("survives the half-written line a crash leaves", async () => {
    const path = join(dir, "log.jsonl");
    const whole = await readFile(path, "utf8");
    await writeFile(path, `${whole}{"k":"move","entry":{"mo`);

    // The torn line is dropped; every complete one before it still counts, so
    // the archive is short of nothing it had actually finished writing.
    const game = await readArchive(dir);
    const verdict = await verifyArchive(game);
    expect(verdict.problems).toEqual([]);
    await writeFile(path, whole);
  });
});

describe("an archive kept by a peer that arrived late", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tessera-fragment-"));
    await played(dir, 900);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // A fragment is worth keeping — the signatures in it are as real as any
  // others — but it cannot be replayed from the genesis record, and the archive
  // says so rather than leaving a reader with an unexplained hash.
  it("says so rather than pretending to be whole", async () => {
    const game = await readArchive(dir);
    expect(game.from).toBe(900);

    const verdict = await verifyArchive(game);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.some((one) => one.includes("begins at step 900"))).toBe(true);
  });
});
