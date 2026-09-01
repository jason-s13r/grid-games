// One game, four keypairs, built fresh for whichever suite asks.
//
// Vitest gives each test file its own module registry, so a suite that mutates
// what it is handed — roster.amend seats a fourth member — cannot leak that
// into another file.

import { CONTROL, MEMBER, makeGenesis } from "@tessera/sim";
import type { Genesis, Move } from "@tessera/sim";
import { MOVE } from "@tessera/sim";
import { Identity } from "../identity.js";
import { sealGenesis } from "../genesis.js";
import { Roster } from "../roster.js";

export interface Fixture {
  alice: Identity;
  bob: Identity;
  carol: Identity;
  /** On no roster anywhere: every check that something is refused uses this. */
  mallory: Identity;
  /** Unsealed, for the checks that need to tamper before the id is computed. */
  base: Genesis;
  genesis: Genesis;
  gameId: string;
  roster: Roster;
  /** A second game with the same roster, for replay-across-games checks. */
  otherGame: Genesis;
}

export async function fixture(): Promise<Fixture> {
  const [alice, bob, carol, mallory] = await Promise.all([
    Identity.generate(),
    Identity.generate(),
    Identity.generate(),
    Identity.generate(),
  ]);

  const base = makeGenesis({
    seed: 7,
    startedAt: 1_700_000_000_000,
    map: { width: 32, height: 32 },
    empires: [
      {
        control: CONTROL.HUMAN,
        members: [
          { kind: MEMBER.HUMAN, key: alice!.key },
          { kind: MEMBER.HUMAN, key: bob!.key },
          { kind: MEMBER.HUMAN, key: carol!.key },
        ],
      },
      { control: CONTROL.SIMBOT, members: [{ kind: MEMBER.BOT }] },
    ],
  });

  const genesis = await sealGenesis(base);
  const otherGame = await sealGenesis(makeGenesis({ seed: 999, empires: base.empires }));

  return {
    alice: alice!,
    bob: bob!,
    carol: carol!,
    mallory: mallory!,
    base,
    genesis,
    gameId: genesis.gameId!,
    roster: Roster.fromGenesis(genesis),
    otherGame,
  };
}

export const claim = (
  step: number,
  empire: number,
  member: number,
  seq: number,
  x: number,
  y: number,
): Move => ({ step, empire, member, seq, type: MOVE.CLAIM, x, y });
