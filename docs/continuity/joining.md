# Joining

Six ways a peer arrives, all through the same [`Lobby`](../mesh/the-lobby.md):

1. **At the start, by signing** — somebody proposes a world, and signing it is
   what seats you. The roster of a [co-signed genesis](../mesh/the-lobby.md)
   *is* the set of signatures over it, so nobody can put you in a game you did
   not agree to, and nobody else signing changes the world you did.
2. **At the start, from somebody's setup screen** — the older path, where the
   host composes and seals the [genesis](../protocol/genesis.md) and everybody
   else's only response is refusal. Still how a game with teams in it is made.
3. **Mid-game, as a reloading tab** — same identity, same seat, from
   `localStorage`.
4. **Mid-game, invited** — an [observer](../concepts/peers-and-roles.md) until an
   empire votes it a seat by [`ROSTER_AMEND`](roster-amendments.md). Somebody
   inside has to think of you.
5. **Mid-game, by asking** — an observer *applies* to an empire, and the seats
   already there decide. Same `ROSTER_AMEND` and the same quorum; what is new is
   who may start one. See below.
6. **Mid-game, by taking an empire nobody has** — a
   [vacancy](../gameplay/empires-and-seats.md), which needs nobody's permission
   because there is nobody to ask.

Four and five reach the same place by different doors, and the difference is
worth stating: an invitation needs a member to think of you, an application needs
one to agree with you.

One and two differ in what the record can later prove. A signed world composes a
record carrying the signatures that made it, so a reader can check that its
players agreed to the rules they played under; a composed one carries nothing to
check, and [reads `consent: not stated`](../trust-and-verification/verifying-an-archive.md).

**Pre-game and mid-game arrival still differ**, and the gap is teams. One signer
is one empire, because a signer choosing an empire is a signer who must re-sign
when somebody else takes it — the never-settling proposal in miniature. A team
forms after step 0 by [`ROSTER_AMEND`](roster-amendments.md), which is the
mechanism that already exists.

## The handshake

When a connection opens, each side sends a `HELLO`
([`lobby.ts:214`](../../packages/net/src/lobby.ts#L214)) carrying `protocol`, its
`key` (absent for an observer) and a 16-byte `nonce`. In the lobby the `gameId`
is `""` — there is no game yet, and a lobby hello proves nothing beyond "here is
a key to seat me under".

The mutual challenge-response proper (`hello` / `welcome` / `proof`, each side
signing **both** nonces — [`records.ts:522`](../../packages/protocol/src/records.ts#L522))
establishes **possession of a key** and nothing more. That is enough, because
every [move](../moves/move-encoding.md) is separately signed against the real
game id anyway. `verifyHello` never replays: swap the nonces, or aim the proof at
another game or another key, and it fails.

## Getting the genesis

A mid-game joiner cannot *ask* for the genesis — until it has the record it does
not know the game id every other frame is signed against. So when a peer connects
to the [lobby](../mesh/the-lobby.md), `welcome()` immediately sends it the
`sealed` `GENESIS` frame ([`lobby.ts:161`](../../packages/net/src/lobby.ts#L161)).
**Every** peer keeps `sealed`, not just the host — by the time someone reloads,
the host may be long gone.

The `GENESIS` frame carries the **full record**, so the joiner computes the game
id itself ([genesis.md](../protocol/genesis.md)) rather than taking anyone's
word.

## Building the driver

`lobby.onStart(genesis, seat, transport)` fires. The client / headless peer
builds a `Sim`, a `Roster.fromGenesis`, and a [`Lockstep`](lockstep.md) with the
`seat` (or `undefined` for an observer). Frames that arrived during the gap are
replayed out of the lobby's `backlog`.

`Lockstep.start()` ([`lockstep.ts:336`](../../packages/net/src/lockstep.ts#L336))
then checks `targetStep() - sim.step`: if that gap is more than `RESUME_BEHIND`
(2 s), **the game began without us** and there are inputs we can never obtain —
so it enters `holdingForResume` and asks for a snapshot rather than replaying
from step 0. See [resume.md](resume.md).

## Taking a seat

A newcomer voted in by [`ROSTER_AMEND`](roster-amendments.md) receives
`onSeated`; if the seated key is its own and it had no seat,
[`seatArrivals`](../../packages/net/src/lockstep.ts#L1086) sets
`options.seat = { empire, member }` and resets `seq = 0`. From that step it is an
ordinary player. `seq` restarting is why [equivocation](equivocation.md)
detection keys on the step, not just the seq.

A reloading tab that kept its seat rejoins with move numbering restarted and
nobody accused — [`resume.test.ts`](../../packages/net/src/test/resume.test.ts)
holds it.

## Asking for one

Before applications, a peer with a key and no seat had **no channel to the game
at all**: `amend` needs a seat to propose from, and `say` needs one to attribute
a message to. Watching a game you would like to play, there was nothing you could
do about it.

An application is a record signed by the person asking — the same self-signed
shape a [claim](../gameplay/empires-and-seats.md) uses, and verifiable by a peer
that has never heard of the signer. `Lockstep.apply(empire)` sends it;
`applications()` is the list a member decides from; `admit(empire, key)` is a
member agreeing. Everything downstream — the quorum, the merge, the gossip, the
seating — is the amendment machinery that already existed. **This adds a way to
ask; it changes nothing about how the answer is reached.**

Three properties are load-bearing.

**It carries no scheduling weight.** The tempting implementation is an amendment
with no signatures on it yet, and that record is refused on purpose: it would
both spread junk and hold the pipeline open at a step nobody was going to vote
on, which is a free denial of service. An application names no step the pipeline
must reach, and only the amendment it becomes does.

**It is repeated, not remembered.** An amendment is gossiped by *growth* — a peer
rebroadcasts one whose signature count went up — and an application never grows:
one signature, from one key, forever. Broadcast once it reaches whoever happened
to be connected in that instant, and a mesh takes a second hop to form. So it is
re-signed on a slow timer and sent again, exactly as a readiness promise is. Its
`step` therefore means *still asking, as of*, expiry is a comparison rather than
a deadline somebody chose, and an applicant who closed their tab withdraws
themselves within a minute.

**A driver stores only what is addressed to its own empire.** Key generation is
free, so a single shared list would let a handful of throwaway identities evict
every real applicant to every empire. Holding only your own list means somebody
else's flood costs you nothing, and your own is a list your own members can
ignore. It is capped at 32, oldest out.

Saying yes is two calls, not one, and only one of them is `amend`. The first
member of an empire to agree starts a proposal; everybody after them signs the
one that exists. Without that split a three-seat empire fails with no error
anywhere — two records at two steps, each one signature short, both drivers
having spent the single endorsement they are allowed for that key. `admit` is
where the split lives, along with the guard that stops a member of one empire
admitting another's applicant onto their own team.

Refusal needs no record. An application nobody endorses expires, and "we did not
seat you" is the absence of an amendment rather than a signed rejection — a
signed refusal would be a rule about who may ask, which is a different and much
worse feature.
