#!/usr/bin/env node
// Signing, framing and roster harness.
//
// Everything Phase C's trust model rests on is checked here rather than
// reasoned about: that a signature binds to one game, one seat, one record
// type and one exact set of field values, and that nothing a peer sends can
// throw on the receiving side.

import { CONTROL, MEMBER, MOVE, Sim, makeGenesis } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import { Identity, fingerprint, randomBytes } from "./identity.js";
import { canonicalJson, gameIdOf, inspectGenesis, sealGenesis } from "./genesis.js";
import { Roster } from "./roster.js";
import {
  CHANNEL,
  EquivocationWatch,
  amendmentMove,
  encodeMessage,
  encodeMove,
  endorseAmendment,
  proveHello,
  signMessage,
  signReady,
  signMove,
  verifyAmendment,
  verifyEquivocation,
  verifyHello,
  verifyMessage,
  verifyMove,
  verifyReady,
} from "./records.js";
import type { Amendment, SignedAmendment, SignedMove } from "./records.js";
import { FRAME, decodeFrame, encodeFrame } from "./wire.js";
import { toBase64Url } from "./bytes.js";

let failures = 0;
let checks = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  checks++;
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m ${label}`);
  } else {
    failures++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const eq = (label: string, actual: unknown, expected: unknown): void =>
  ok(label, actual === expected, `expected ${expected}, got ${actual}`);

const section = (name: string): void => console.log(`\n${name}`);

const claim = (
  step: number,
  empire: number,
  member: number,
  seq: number,
  x: number,
  y: number,
): Move => ({ step, empire, member, seq, type: MOVE.CLAIM, x, y });

async function main(): Promise<void> {
  // --- fixtures --------------------------------------------------------------

  const alice = await Identity.generate();
  const bob = await Identity.generate();
  const carol = await Identity.generate();
  const mallory = await Identity.generate();

  const base = makeGenesis({
    seed: 7,
    startedAt: 1_700_000_000_000,
    map: { width: 32, height: 32 },
    empires: [
      {
        control: CONTROL.HUMAN,
        members: [
          { kind: MEMBER.HUMAN, key: alice.key },
          { kind: MEMBER.HUMAN, key: bob.key },
          { kind: MEMBER.HUMAN, key: carol.key },
        ],
      },
      { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
    ],
  });
  const genesis = await sealGenesis(base);
  const gameId = genesis.gameId!;
  const roster = Roster.fromGenesis(genesis);

  // --- canonical serialisation ----------------------------------------------

  section("canonical records");
  eq(
    "key order does not change the encoding",
    canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] }),
    canonicalJson({ a: [2, { c: 3, d: 4 }] as unknown[], b: 1 }),
  );
  eq("undefined fields are dropped", canonicalJson({ a: 1, b: undefined }), '{"a":1}');
  ok(
    "a non-finite number is refused",
    ((): boolean => {
      try {
        canonicalJson({ a: Number.NaN });
        return false;
      } catch {
        return true;
      }
    })(),
  );

  section("genesis");
  eq("the game id is a sha-256 digest", gameId.length, 64);
  eq("sealing is idempotent", await gameIdOf(genesis), gameId);
  ok(
    "any change moves the game id",
    (await gameIdOf({ ...genesis, seed: 8 })) !== gameId,
  );
  eq("a well-formed genesis has no problems", (await inspectGenesis(genesis)).length, 0);
  ok(
    "a tampered game id is caught",
    (await inspectGenesis({ ...genesis, seed: 8 })).includes("gameId"),
  );
  ok(
    "a mismatched protocol is refused",
    (await inspectGenesis({ ...base, protocol: 99 } as Genesis)).includes("protocol"),
  );
  ok(
    "one key cannot hold two seats",
    (
      await inspectGenesis(
        await sealGenesis(
          makeGenesis({
            seed: 1,
            empires: [
              { members: [{ key: alice.key }, { key: alice.key }] },
            ],
          }),
        ),
      )
    ).includes("duplicate-key"),
  );

  // --- identity --------------------------------------------------------------

  section("identity");
  eq("a public key is a 65-byte point", (alice.key.length * 3) >> 2, 65);
  const restored = await Identity.restore(await alice.export());
  eq("a keypair round-trips through storage", restored?.key, alice.key);
  ok("a corrupt store restores to nothing", (await Identity.restore("{")) === null);
  eq("a fingerprint is eight hex characters", (await fingerprint(alice.key)).length, 8);

  // --- signed moves ----------------------------------------------------------

  section("signed moves");
  const move = claim(120, 1, 0, 3, 10, 12);
  const signed = await signMove(alice, gameId, move);
  ok("a member's own move verifies", await verifyMove(roster, gameId, signed));

  ok(
    "a tampered coordinate is caught",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, x: 11 } })),
  );
  ok(
    "a tampered step is caught",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, step: 121 } })),
  );
  ok(
    "moving as a seat you do not hold is caught",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, member: 1 } })),
  );
  ok(
    "a non-roster key cannot act",
    !(await verifyMove(roster, gameId, await signMove(mallory, gameId, move))),
  );
  ok(
    "an empty seat cannot act",
    !(await verifyMove(roster, gameId, await signMove(alice, gameId, claim(120, 2, 0, 3, 1, 1)))),
  );

  const otherGame = await sealGenesis(makeGenesis({ seed: 999, empires: base.empires }));
  ok(
    "a move cannot be replayed into another game",
    !(await verifyMove(roster, otherGame.gameId!, signed)),
  );

  const message = {
    step: 120,
    seq: 3,
    empire: 1,
    member: 0,
    channel: CHANNEL.PUBLIC,
    body: "hi",
  };
  ok(
    "a move signature is not a message signature",
    !(await verifyMessage(roster, gameId, { message, sig: signed.sig })),
  );
  ok(
    "the two records encode differently",
    toBase64Url(encodeMove(gameId, move)) !== toBase64Url(encodeMessage(gameId, message)),
  );

  ok(
    "an out-of-range coordinate is refused, not truncated",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, x: 65536 } })),
  );
  ok(
    "nobody signs as neutral",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, empire: 0 } })),
  );
  ok(
    "an unknown move type is refused",
    !(await verifyMove(roster, gameId, { ...signed, move: { ...move, type: 99 as never } })),
  );
  ok(
    "a garbage signature verifies false rather than throwing",
    !(await verifyMove(roster, gameId, { move, sig: "!!!not base64!!!" })),
  );

  // --- chat ------------------------------------------------------------------

  section("chat");
  const chat = await signMessage(bob, gameId, { ...message, member: 1, body: "on my way" });
  ok("a signed message verifies", await verifyMessage(roster, gameId, chat));
  ok(
    "an edited message is caught",
    !(await verifyMessage(roster, gameId, {
      ...chat,
      message: { ...chat.message, body: "on my way!" },
    })),
  );
  ok(
    "an oversized body is refused",
    !(await verifyMessage(roster, gameId, {
      ...chat,
      message: { ...chat.message, body: "x".repeat(4096) },
    })),
  );

  section("readiness");
  const ready = await signReady(alice, gameId, { upTo: 300, empire: 1, member: 0 });
  ok("a readiness claim verifies", await verifyReady(roster, gameId, ready));
  ok(
    "raising someone else's readiness is caught",
    !(await verifyReady(roster, gameId, { ...ready, ready: { ...ready.ready, upTo: 900 } })),
  );
  ok(
    "readiness cannot be asserted on another seat's behalf",
    !(await verifyReady(roster, gameId, { ...ready, ready: { ...ready.ready, member: 1 } })),
  );

  // --- roster and amendments -------------------------------------------------

  section("roster");
  eq("a seat resolves to its key", roster.keyOf(1, 1), bob.key);
  eq("a key resolves to its seat", roster.seatOf(carol.key)?.member, 2);
  eq("three seats need two signatures", roster.quorum(1), 2);
  eq("a SimBot empire has no keyed seats", roster.membersOf(2).length, 0);

  const amendment: Amendment = {
    empire: 1,
    step: 500,
    key: mallory.key,
    kind: MEMBER.HUMAN,
  };
  const one: SignedAmendment = {
    amendment,
    signatures: [await endorseAmendment(alice, gameId, amendment, 0)],
  };
  ok("one signature is not a quorum", !(await verifyAmendment(roster, gameId, one)));

  const doubled: SignedAmendment = {
    amendment,
    signatures: [
      await endorseAmendment(alice, gameId, amendment, 0),
      await endorseAmendment(alice, gameId, amendment, 0),
    ],
  };
  ok("one member cannot sign twice for a quorum", !(await verifyAmendment(roster, gameId, doubled)));

  const forged: SignedAmendment = {
    amendment,
    signatures: [
      await endorseAmendment(alice, gameId, amendment, 0),
      // Mallory signing in Bob's seat: the roster looks the key up by seat, so
      // the signature is checked against Bob's key and fails.
      await endorseAmendment(mallory, gameId, amendment, 1),
    ],
  };
  ok("a forged endorsement does not count", !(await verifyAmendment(roster, gameId, forged)));

  const quorum: SignedAmendment = {
    amendment,
    signatures: [
      await endorseAmendment(alice, gameId, amendment, 0),
      await endorseAmendment(bob, gameId, amendment, 1),
    ],
  };
  ok("a quorum is accepted", await verifyAmendment(roster, gameId, quorum));

  const seated = roster.amend(1, mallory.key, MEMBER.HUMAN, 500);
  eq("the new seat takes the next index", seated, 3);
  ok(
    "an already-seated key cannot be added again",
    !(await verifyAmendment(roster, gameId, quorum)),
  );
  ok(
    "the newcomer can now act",
    await verifyMove(
      roster,
      gameId,
      await signMove(mallory, gameId, claim(501, 1, seated, 0, 4, 4)),
    ),
  );
  eq("four seats need three signatures", roster.quorum(1), 3);

  section("the amendment reaches the simulation");
  const sim = new Sim(genesis);
  const before = sim.state.empires[0]!.members.length;
  sim.advance([amendmentMove(amendment, 0, 0)]);
  eq("the sim seated the new member", sim.state.empires[0]!.members.length, before + 1);
  eq("the kind survived the trip", sim.state.empires[0]!.members[before]!.kind, MEMBER.HUMAN);

  // --- handshake -------------------------------------------------------------

  section("handshake");
  const mine = randomBytes(16);
  const theirs = randomBytes(16);
  const proof = await proveHello(alice, gameId, theirs, mine);
  ok("a fresh proof verifies", await verifyHello(alice.key, gameId, theirs, mine, proof));
  ok(
    "a proof does not replay with the nonces swapped",
    !(await verifyHello(alice.key, gameId, mine, theirs, proof)),
  );
  ok(
    "a proof does not carry to another game",
    !(await verifyHello(alice.key, otherGame.gameId!, theirs, mine, proof)),
  );
  ok(
    "a proof does not carry to another key",
    !(await verifyHello(bob.key, gameId, theirs, mine, proof)),
  );

  // --- equivocation ----------------------------------------------------------

  section("equivocation");
  const watch = new EquivocationWatch();
  const first: SignedMove = await signMove(alice, gameId, claim(200, 1, 0, 9, 1, 1));
  const same: SignedMove = await signMove(alice, gameId, claim(200, 1, 0, 9, 1, 1));
  const other: SignedMove = await signMove(alice, gameId, claim(200, 1, 0, 9, 2, 2));

  ok("a first sighting is not a crime", watch.record(first) === null);
  ok("re-hearing the same move is not a crime", watch.record(same) === null);
  const caught = watch.record(other);
  ok("two moves in one slot are caught", caught !== null);
  ok(
    "the proof stands on its own",
    caught !== null && (await verifyEquivocation(roster, gameId, { a: caught, b: other })),
  );
  ok(
    "an accusation from identical moves is refused",
    !(await verifyEquivocation(roster, gameId, { a: first, b: same })),
  );
  ok(
    "an accusation needs two valid signatures",
    !(await verifyEquivocation(roster, gameId, {
      a: first,
      b: { ...other, sig: first.sig },
    })),
  );

  // A reload builds a fresh driver, whose seq counter starts again at zero. The
  // seat is then honestly re-spending numbers its peers still remember. That is
  // a rejoin, not a contradiction, and it must not cost anyone their seat.
  const rejoined: SignedMove = await signMove(alice, gameId, claim(240, 1, 0, 9, 3, 4));
  ok("a reused seq at a later step is not a crime", watch.record(rejoined) === null);
  ok(
    "and it cannot be dressed up as a proof",
    !(await verifyEquivocation(roster, gameId, { a: other, b: rejoined })),
  );

  // --- framing ---------------------------------------------------------------

  section("framing");
  const frame = encodeFrame({ t: FRAME.MOVE, signed });
  const decoded = decodeFrame(frame);
  eq("a move frame round-trips", decoded?.t, FRAME.MOVE);
  eq(
    "the payload survives intact",
    decoded?.t === FRAME.MOVE ? decoded.signed.sig : "",
    signed.sig,
  );

  eq("a genesis frame round-trips", decodeFrame(encodeFrame({ t: FRAME.GENESIS, genesis }))?.t, FRAME.GENESIS);
  ok("malformed json decodes to nothing", decodeFrame("{") === null);
  ok("an unknown frame type decodes to nothing", decodeFrame('{"t":"attack"}') === null);
  ok("a frame missing its payload decodes to nothing", decodeFrame('{"t":"move"}') === null);
  ok("a non-object decodes to nothing", decodeFrame('"move"') === null);
  ok(
    "a hello without a nonce decodes to nothing",
    decodeFrame('{"t":"hello","protocol":1,"gameId":"a"}') === null,
  );
  ok(
    "a negative snapshot step decodes to nothing",
    decodeFrame('{"t":"snapshot?","step":-1}') === null,
  );

  // --- the whole path --------------------------------------------------------

  section("wire to simulation");
  const live = new Sim(genesis);
  const capital = live.state.empires[0]!.capital;
  const target = capital + 1;
  const play = claim(
    live.step,
    1,
    0,
    0,
    target % live.state.width,
    Math.floor(target / live.state.width),
  );
  const onWire = encodeFrame({ t: FRAME.MOVE, signed: await signMove(alice, gameId, play) });
  const back = decodeFrame(onWire);
  ok(
    "a move survives signing, framing, parsing and verification",
    back?.t === FRAME.MOVE && (await verifyMove(roster, gameId, back.signed)),
  );
  ok(
    "and the simulation is the one that decides whether it is legal",
    back?.t === FRAME.MOVE && typeof live.validate(back.signed.move) === "boolean",
  );

  console.log(
    `\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${checks - failures}/${checks} checks passed\x1b[0m`,
  );
  if (failures > 0) process.exitCode = 1;
}

void main();
