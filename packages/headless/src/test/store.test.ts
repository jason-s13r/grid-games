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
import { Identity, claimMove, sealGenesis, signClaim, signMove } from "@tessera/protocol";
import type { SignedMove } from "@tessera/protocol";
import { ARCHIVE_FORMAT, verifyArchive } from "@tessera/net";
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

describe("a game whose first move is not on step 0", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tessera-late-"));
    const identity = await Identity.generate();
    const genesis = await sealGenesis(
      makeGenesis({
        seed: 3,
        startedAt: 0,
        map: { width: 24, height: 24 },
        empires: [
          { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: identity.key }] },
          { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
        ],
      }),
    );

    const sim = new Sim(genesis);
    const file = new FileArchive({ dir, genesis, source: sim });
    await file.open();

    // Nothing happens for a while, which is an ordinary game: a player looking at
    // the board is a player who has not clicked.
    for (let step = 0; step < 20; step++) {
      if (step === 14) {
        const move: Move = {
          step,
          empire: 1,
          member: 0,
          seq: 0,
          type: MOVE.HEARTBEAT,
          x: 0,
          y: 0,
        };
        const envelope = await signMove(identity, genesis.gameId!, move);
        file.archive.applied(step, [envelope.move], [envelope]);
        sim.advance([envelope.move]);
        continue;
      }
      file.archive.applied(step, [], []);
      sim.advance([]);
    }
    await file.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("still begins at the start, and still replays", async () => {
    // `from` used to be the step of the first *record*, which is a different
    // thing from the step this peer started watching: a complete log of a quiet
    // opening claimed to begin at step 14 and was refused as a fragment. Every
    // archive of a real game was refused that way, and the leaderboard counted
    // none of them.
    const game = await readArchive(dir);
    expect(game.from).toBe(0);

    const verdict = await verifyArchive(game);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });
});

describe("a game this peer jumped into the middle of", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tessera-gap-"));
    const identity = await Identity.generate();
    const genesis = await sealGenesis(
      makeGenesis({
        seed: 5,
        startedAt: 0,
        map: { width: 24, height: 24 },
        empires: [
          { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: identity.key }] },
          { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
        ],
      }),
    );

    const sim = new Sim(genesis);
    const file = new FileArchive({ dir, genesis, source: sim });
    await file.open();

    for (let step = 0; step < 10; step++) {
      file.archive.applied(step, [], []);
      sim.advance([]);
    }
    // A snapshot was adopted: the simulation moved rather than advancing, and the
    // inputs in between were never seen by this peer. Asking for a snapshot is the
    // normal answer to a socket blink now, so this is the routine case for a
    // process that runs for days.
    file.archive.gap(40);
    await file.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("says so, and is refused as the fragment it is", async () => {
    const game = await readArchive(dir);
    expect(game.from).toBe(40);
    expect(game.gaps).toEqual([40]);

    // Refused by every reader, including one written before gaps existed: `from`
    // is what does the refusing, and `gaps` only says where the hole is.
    const verdict = await verifyArchive(game);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(" ")).toMatch(/begins at step 40/);
  });
});

describe("a game somebody claimed a vacancy in", () => {
  let dir: string;
  let sim: Sim;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "tessera-claim-"));

    const seated = await Identity.generate();
    const arriving = await Identity.generate();
    // Empire 2 is left empty on purpose — a vacancy, which is the entire point
    // of 0010 and the case this archive has to survive.
    const genesis = await sealGenesis(
      makeGenesis({
        seed: 7,
        startedAt: 0,
        map: { width: 24, height: 24 },
        empires: [
          { control: CONTROL.HUMAN, members: [{ kind: MEMBER.HUMAN, key: seated.key }] },
          { control: CONTROL.HUMAN, members: [] },
        ],
      }),
    );

    sim = new Sim(genesis);
    const file = new FileArchive({ dir, genesis, source: sim });
    await file.open();

    const AT = 8;
    const claim = await signClaim(arriving, genesis.gameId!, { empire: 2, step: AT });
    let seq = 0;

    for (let step = 0; step < 30; step++) {
      const moves: Move[] = [];
      const signed: SignedMove[] = [];
      if (step === AT) {
        // The record and the move it produces, exactly as the driver writes
        // them: the claim on its own line, and the roster-amend move unsigned in
        // the log, because there was no existing seat to attribute it to.
        file.archive.claim(claim);
        moves.push(claimMove(claim.claim, seq++));
      }
      if (step === 20) {
        // A move from the seat the claim created. This is the one that fails
        // when the claim is lost: the roster is rebuilt without the seat, the
        // signature is attributed to nobody, and the report names a bad
        // signature rather than a reader that threw a record away.
        const move: Move = { step, empire: 2, member: 0, seq: seq++, type: MOVE.HEARTBEAT, x: 0, y: 0 };
        const envelope = await signMove(arriving, genesis.gameId!, move);
        moves.push(envelope.move);
        signed.push(envelope);
      }
      file.archive.applied(step, moves, signed);
      sim.advance(moves);
    }

    await file.close();
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads the claim back off disk", async () => {
    const game = await readArchive(dir);
    // `Archive.record` has written a `{k:"claim"}` line since 0010 and
    // `readArchive` had no branch for it, so every game with a vacancy in it
    // lost its claims on the way out — silently, because the file was never
    // missing them.
    expect(game.claims).toHaveLength(1);
    expect(game.claims?.[0]?.claim.empire).toBe(2);
  });

  it("reports the format it actually wrote", async () => {
    const game = await readArchive(dir);
    // Stamped `1` while the writer was at `ARCHIVE_FORMAT = 2`. The two bugs
    // covered for each other: `verifyArchive` refuses a v1 file carrying
    // claims, and the claims had already been discarded, so the guard written
    // for exactly this file could never fire.
    expect(game.format).toBe(ARCHIVE_FORMAT);
  });

  it("and verifies, roster and hash both", async () => {
    const verdict = await verifyArchive(await readArchive(dir));
    // Today this reports `bad signature at step 20 from 2:0` and a hash
    // mismatch — which reads as a tampered archive rather than as a reader that
    // dropped a record. `tessera-observe verify`, `tessera-observe rank` and
    // `tessera-host import` are all wrong about these files.
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.hash).toBe(hex(sim.hash()));
  });
});
