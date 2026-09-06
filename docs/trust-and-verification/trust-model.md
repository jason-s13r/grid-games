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
| Hand out a poisoned snapshot | it is [content-addressed](../continuity/resume.md) — the receiver re-hashes it and reverts if the number is wrong |
| Vote themselves a bigger team | the [seat cap](../gameplay/empires-and-seats.md) is in the genesis **and** re-checked on every amendment |
| Assert readiness on another seat's behalf | [`Ready`](../protocol/signed-records.md) is signed; doing so and then submitting a move is provable equivocation |
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
