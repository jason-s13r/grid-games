# The trust model

Anyone may connect and observe. Only keys in the [roster](../protocol/roster.md)
produce accepted [moves](../moves/the-move-record.md), so an arbitrary mid-game
join is an [observer **by construction**](../concepts/peers-and-roles.md) — there
is no mechanism to configure and nothing to switch off.

## What an attacker cannot do

| Attack | Why it fails |
|---|---|
| Forge a move for a seat they do not hold | the signature is [verified against the roster](../moves/move-encoding.md), not a key in the move |
| Replay a move into another game, or as another record type | the [domain tag and game id](../protocol/signed-records.md) are in the signed bytes |
| Submit an illegal move | every peer runs [`validate`](../moves/validation.md) — a pure function of state |
| Lie about the outcome | [stats are hashed](../continuity/what-is-hashed.md); archives are [replayed](verifying-an-archive.md) |
| Hand out a poisoned snapshot **into a live game** | the receiver re-hashes it and reverts if the number is wrong — and, because the hash is only a 32-bit content address and bytes with a chosen hash are cheap to produce, the property that actually defeats it is that every seat's **signed** checkpoint contradicts the forgery within one interval, and the receiver [rebuilds](../continuity/desync.md) |
| Hand out a poisoned snapshot **into a dormant game** | narrowed rather than closed. With nobody left to contradict it, a forger is stopped only by a [resume point](../continuity/resume-points.md)'s witnesses, which force the lie onto a step the game really reached with a hash its seats really signed |
| Forge or alter anything as the **host peer** | a host's authority ends at the genesis, which every peer checks for itself — and on the [co-signed path](../mesh/the-lobby.md) it does not begin there either: the roster is the set of signatures over the world, so a sealer cannot change a rule, seat a non-signer, invent a player or reorder the roster. What is left to it is deciding who was late. As a peer it holds no seat and changes no hash; as a [relay](../mesh/room-bus.md) it can silence one seat while carrying the rest, and that ends in a quorum-signed ejection recorded in every archive — denial of play, never authority |
| Vouch for its own [resume point](../continuity/resume-points.md) | a host holds no seat, so it signs no checkpoints and can never be a witness. It stores and serves an artifact only the players could have produced |
| Vote themselves a bigger team | the [seat cap](../gameplay/empires-and-seats.md) is in the genesis **and** re-checked on every amendment |
| Assert readiness on another seat's behalf | [`Ready`](../protocol/signed-records.md) is signed; doing so and then submitting a move is provable equivocation |
| Fill an [address book](../mesh/address-book.md) with games that do not exist | it cannot be stopped, only priced: a row is only believable to the extent it carries [witnesses](../continuity/resume-points.md), and a majority of a game's seats signing *(step, hash)* is a thing only that game's players could have produced. Well-formed fiction is *returned and marked unproven*, because a game composed five minutes ago has no witnesses either |
| Point a board row at a room running a different game | the row's genesis is re-hashed before it is shown, and the client dials with `expect: gameId` — a room that answers with another record is [refused by the lobby](../mesh/the-lobby.md) rather than played |
| Exhaust another peer's memory | moves beyond `moveHorizon` are discarded; snapshot partials are bounded ([chunking](../mesh/webrtc-mesh.md)) |

[`forgery.test.ts`](../../packages/net/src/test/forgery.test.ts): "a forged move
changes nothing; the victim still agrees; a non-roster peer is simply an
observer".

## What an attacker can do

- **Equivocate** — sign two different moves for one slot. Because the mesh
  gossips every move it sees, this is *detected* rather than merely suspected,
  with a [self-contained proof](../continuity/equivocation.md) any peer can check,
  and the cheat is ejected at a step derived from the proof.
- **Drop packets** (if it is relaying traffic). Which is why
  [TURN](../mesh/webrtc-mesh.md) is a *bandwidth* dependency and never an
  *authority* one — a relay can stall a connection but cannot forge or alter a
  single move.

## The board

An [address book](../mesh/address-book.md) is a bulletin board of connection
parameters, and it is trusted with none of them. It can flicker rows (bounded by
the TTL — the next heartbeat restores them), show fiction (returned, and marked as
carrying no proof), refuse to answer, and learn which games a reader asks about.
What it cannot do is forge a game, because the binding `refs → gameId` is only as
good as the genesis the reader hashes — and since `expect`, it cannot misroute one
either. Its worst honest power is to waste your time.

The write rule is access control and not adjudication: a row is owned by the key
that announced it, so `present` and `withdraw` need that key's signature. The
signature says who posted a row, never that the row is true.

None of that changes when the board is one we run. [`apps/api`](../clients/api-service.md)
is a board, so the paragraph above is its whole power and the page describing it
is mostly a list of what it refuses to decide. The value of this section is that
it is true for a board run by a stranger; a hosted one is not more trustworthy
for being hosted, and if it ever needed to be, the client would have been
simplified somewhere it should not have been.

## An archive store

A store of finished games can withhold a file, serve an old copy of a game two
observers archived differently, refuse to answer, and learn which games a reader
asks for. What it cannot do is give you a **different** game, because the id is a
hash of the genesis record and the reader recomputes it, or an **altered** one,
because the reader replays it. Its worst honest power, as with the board, is to
waste your time.

It is not trusted to have verified anything either. A store replays every file on
the way in and keeps only what passes, which is what lets it accept uploads from
anyone — but that check is the reader's own check run early, not a substitute for
it. The corpus it publishes is over what was sent to it and claims nothing about
completeness: nothing makes a peer upload, and nothing notices a game that ended
and was never archived.

## A hosted leaderboard

Its power is **selection**: which archives it holds, which it refused, and what it
left out of its corpus. It has none over the figures, because every one of them
is recomputed from a file whose hash the reader checks — so the defence is that
the corpus is published, which makes selection visible.

The window table ships the ids it counted and a reader can fetch those files and
re-derive it. The all-time table cannot be replayed once the files are evicted;
what is published instead is the applied-set, so the totals are a pure function of
a list anybody can fetch, and an arithmetic error is visible without holding a
single archive. What remains, and the scope sentence has to carry it: an evicted
game's existence is unfalsifiable by a stranger who never held it.

## The broker

PeerJS's public broker does [signalling only](../mesh/webrtc-mesh.md) — it
introduces two peers and then has no part in the game. It never sees a move,
cannot alter one, and is swappable. "Serverless" means **zero authority
servers**, and that property survives a TURN relay intact.

## Headless peers hold no extra trust

The [observer](../clients/observer.md) and [bot](../clients/bot.md) are ordinary
peers. The observer holds no seat and its checkpoint vote counts like anyone's;
the bot holds one seat, voted in by [`ROSTER_AMEND`](../continuity/roster-amendments.md),
at the cost of a seat. Neither can do anything a browser tab could not.
