# The leaderboard

[`rankArchives(games)`](../../packages/net/src/rankings.ts#L112) is a
**derivation, not a record**. Every figure is read out of hashed state after
[replaying a verified log](verifying-an-archive.md) — so the table is not a record
of what happened, it is a *recomputation* of it, and anyone holding the same
files computes the same table.

## Standing

Keyed by [`MemberKey`](../protocol/identity.md) — a key is the only identity this
game has (seat numbers are per-game; there are no accounts).

```ts
interface Standing {
  key: MemberKey;
  kind: MemberKind;   // BOT only if EVERY seat this key held was a bot seat
  games: number;
  wins: number;
  moves: number;
  popSpent: number;
  tilesTaken: number;
  bestMove: number;    // most tiles taken by one claim — the one "moment" figure
  bestCascade: number; // largest cascade, in tiles
  peakTiles: number;   // largest the key's empire grew, shared with teammates
}
```

## Ordering

`wins`, then `tilesTaken`, then `bestMove`, then the key itself (so two identical
records come out in the same order on every machine). **Nothing is weighted or
tuned** — every column is a count from hashed state, and the sort is the only
opinion in the file. A rating nobody can explain is a table nobody can check,
which would give back exactly what the signatures were for.

## Refusal is the interesting part

`rankArchives` takes *every* archive you have and:

- runs [`verifyArchive`](verifying-an-archive.md) on each — a failure lands in
  `refused` with its `problems` and its `index` (its position in the input, so a
  caller can name the *file*, since two archives of one game share a game id);
- **counts a game once** — `seen` is keyed on `gameId`, and two observers on one
  game is the *normal* way to keep an archive safe, not a corner case;
- refuses a **fragment** (`from > 0`) — the stats depend on the part it is
  missing;
- refuses a game with an **unsigned move**;
- credits **only seats somebody signs for** — a [SimBot](../gameplay/bots.md)
  holds no key, so there is nobody to credit.

```ts
interface Leaderboard {
  standings: Standing[];
  counted: string[];      // game ids counted, in order
  unfinished: number;     // counted games with no winner — stats but no wins
  refused: Array<{ index: number; game: string; problems: string[] }>;
}
```

## As a command

`tessera-observe rank <dir>` ([observer](../clients/observer.md)) prints the
table **and the refusals** — a leaderboard that silently drops what it could not
check is one nobody can audit.

[`rankings.test.ts`](../../packages/net/src/test/rankings.test.ts): "a row per
signed-for seat and no others"; "figures read from the replay, not the archive";
"counted once however many observers"; "refuses an edited archive / a fragment
and goes on counting the rest".
