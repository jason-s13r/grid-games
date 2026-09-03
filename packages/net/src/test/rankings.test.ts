// A leaderboard nobody has to be trusted for.
//
// The arithmetic is not what these tests are about — adding up tiles taken is
// not where a leaderboard goes wrong. What they are about is refusal: that a
// table counts a game once however many observers kept it, that a tampered
// archive contributes nothing rather than contributing something slightly
// wrong, and that a fragment is refused even though every signature in it is
// genuine. A leaderboard is only worth the games it declines to count.

import { beforeAll, describe, expect, it } from "vitest";
import { MEMBER, MOVE, STAT } from "@tessera/sim";
import type { SignedMove } from "@tessera/protocol";
import { Archive, rankArchives } from "../index.js";
import type { ArchivedGame } from "../index.js";
import { clickAround, run, settleNetwork, table } from "./harness.js";
import type { Table } from "./harness.js";

/** A game played to its end, and the archive an observer kept of it. `endStep`
 *  is what makes it finish inside a test: the clock runs out and the empire
 *  holding the most ground wins on a timeout, which is a real victory decided
 *  by the same code a month-long game would use. */
async function played(seed: number, ended = true): Promise<{ t: Table; game: ArchivedGame }> {
  const t = await table({
    seats: [1, 1],
    observer: true,
    // No SimBot empire: a leaderboard only has rows for seats somebody signs
    // for, so a game won by an unkeyed empire would be a game with a winner and
    // an empty table — true, and no use as a test of who gets credited.
    simbots: 0,
    seed,
    ...(ended ? { rules: { endStep: 30 } } : {}),
  });
  const observer = t.peers.at(-1)!;
  const archive = new Archive(t.genesis, observer.driver);
  archive.attach(observer.driver);

  await run(t, 40, await clickAround(t, 5));
  await settleNetwork(t);
  return { t, game: archive.toJSON() };
}

describe("a table built from archives", () => {
  let t: Table;
  let game: ArchivedGame;

  beforeAll(async () => {
    ({ t, game } = await played(7));
  });

  it("counts the game once and knows who won it", async () => {
    const board = await rankArchives([game]);
    expect(board.refused).toEqual([]);
    expect(board.counted).toEqual([t.gameId]);
    expect(board.unfinished).toBe(0);
    expect(board.standings.reduce((sum, one) => sum + one.wins, 0)).toBe(1);
    // Ranked, so the winner leads.
    expect(board.standings[0]!.wins).toBe(1);
  });

  it("has a row for every seat somebody signed for, and no others", async () => {
    const board = await rankArchives([game]);
    // Three peers played it and two of them held seats: an observer is a peer
    // with no key in the roster, so it is absent from the table by the same
    // construction that makes it an observer.
    const keys = board.standings.map((one) => one.key).sort();
    const played = t.peers
      .filter((peer) => peer.seat)
      .map((peer) => peer.identity!.key)
      .sort();
    expect(keys).toEqual(played);
    expect(board.standings.every((one) => one.kind === MEMBER.HUMAN)).toBe(true);
  });

  it("reads the figures out of the replay rather than off the archive", async () => {
    const board = await rankArchives([game]);
    const seat = t.peers[0]!;
    const mine = board.standings.find((one) => one.key === seat.identity!.key)!;
    const member = seat.driver.sim.state.empires[0]!.members[0]!;
    expect(mine.games).toBe(1);
    expect(mine.moves).toBeGreaterThan(0);
    expect(mine.tilesTaken).toBeGreaterThan(0);
    // The same numbers the peer itself holds, because both are the same hashed
    // state arrived at twice.
    expect(mine.tilesTaken).toBe(member.stats[STAT.TILES_TAKEN]);
    expect(mine.popSpent).toBe(member.stats[STAT.POP_SPENT]);
  });

  it("counts a game once however many observers kept it", async () => {
    const board = await rankArchives([game, structuredClone(game)]);
    expect(board.counted).toEqual([t.gameId]);
    // Named by position, so a caller can say which of the two files it was.
    expect(board.refused).toEqual([
      { index: 1, game: t.gameId, problems: ["already counted from another archive"] },
    ]);
    const solo = await rankArchives([game]);
    expect(board.standings).toEqual(solo.standings);
  });
});

describe("what a table refuses to count", () => {
  let game: ArchivedGame;

  beforeAll(async () => {
    ({ game } = await played(9));
  });

  it("an archive somebody edited afterwards", async () => {
    const forged = structuredClone(game);
    const claim = forged.moveLog.find(
      (entry): entry is SignedMove => "move" in entry && entry.move.type === MOVE.CLAIM,
    )!;
    claim.move.x += 1;

    const board = await rankArchives([forged]);
    expect(board.counted).toEqual([]);
    expect(board.standings).toEqual([]);
    expect(board.refused[0]!.problems.join(" ")).toContain("bad signature");
  });

  it("a fragment, however genuine every signature in it is", async () => {
    const partial = structuredClone(game);
    partial.from = 10;
    partial.moveLog = partial.moveLog.filter((entry) => ("move" in entry ? entry.move : entry).step >= 10);

    const board = await rankArchives([partial]);
    expect(board.counted).toEqual([]);
    expect(board.refused[0]!.problems.join(" ")).toContain("begins at step 10");
  });

  it("something that is not an archive at all", async () => {
    const board = await rankArchives([{} as ArchivedGame]);
    expect(board.refused).toEqual([{ index: 0, game: "unknown", problems: ["not an archive"] }]);
    expect(board.standings).toEqual([]);
  });

  // A refused game must not poison the ones beside it: a directory with one bad
  // file in it is the normal case, not a reason to have no table.
  it("and goes on counting the games around it", async () => {
    const board = await rankArchives([{} as ArchivedGame, game]);
    expect(board.counted).toHaveLength(1);
    expect(board.standings).toHaveLength(2);
  });
});

describe("a game still being played", () => {
  it("contributes its stats and nobody's win", async () => {
    const { game } = await played(11, false);
    const board = await rankArchives([game]);
    expect(board.refused).toEqual([]);
    expect(board.unfinished).toBe(1);
    expect(board.standings.every((one) => one.wins === 0)).toBe(true);
    expect(board.standings.some((one) => one.tilesTaken > 0)).toBe(true);
  });
});
