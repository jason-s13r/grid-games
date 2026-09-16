# Plan index

Status of the series: **all fourteen built.** Built in the order
below; each plan leaves the tree green and is useful on its own. No plan adds authority anywhere — the
sim, the hash contract, quorum signatures and archive verification are
untouched, and everything stored anywhere is checked by whoever reads it.

| # | Plan | Depends on | Size |
|---|------|------------|------|
| 0001 ✅ | Games that outlive their release — the supported protocol set | — | 1 session |
| 0002 ✅ | Games that end — durations, the join window, abandon scaling | 0001 | 1 session |
| 0003 ✅ | The connection reference — a transport chosen by the string you join with | — | 1 session |
| 0004 ✅ | The WSS transport — client, room-bus contract, tests | 0003 | 1–2 sessions |
| 0005 ✅ | Resume points a stranger can check | — | 1 session, hardest |
| 0006 ✅ | The host peer — doorman, relay, archiver | 0004, 0005 | 1–2 sessions |
| 0007 ✅ | The address book — listings and the rejoin flow | 0003, 0006 | 1 session |
| 0008 ✅ | The web client — join, create, watch | 0002, 0003, 0007 | 3 sessions, not 1–2 |
| 0009 ✅ | Composing a game together — the co-signed proposal | 0002, 0006 | 1–2 sessions |
| 0010 ✅ | Vacant empires — arriving at a game that has already started | 0002 | 1–2 sessions, hardest here |
| 0011 ✅ | Applications — asking an empire for a seat | — | 1 session |
| 0012 ✅ | Names and direct messages — the social layer | — | 1–2 sessions |
| 0013 ✅ | Banners — an empire you can play as again | 0009, 0010 | 1 session |
| 0014 ✅ | The lobby rejig and the game log | 0009–0013 | 2 sessions |

## Why this order

- **0001 first**, because it is the only thing standing between a release and
  every game in flight, and 0002 is what makes games long enough to be caught
  by one.
- **0002 second**: it moves `PROTOCOL_VERSION`, the series' only bump, so every
  later plan is written against a number that has already settled.
- **0003 → 0006** is one strand — a ref, a transport, the resume points a host
  peer serves, then the host peer itself. 0005 depends on nothing but is the
  hardest single session in the series; do it before 0006 needs it.
- **0007, 0008** turn that strand into something a player can actually reach.
- **0009 → 0014** is composition, arrival and identity, and 0014 is the screen
  that renders all of it. 0011 and 0012 depend on nothing and touch no
  simulation code, so they can be slotted anywhere.

0008 is the first plan to be split rather than built whole. Its own appendix
recommended it — the replay scrubber is a worker and a snapshot ladder, and the
leaderboard is blocked on an index of finished games that nothing builds — and
what shipped first was the half the title promises — **steps 1–6, finding a game
and joining it** — then **7–9, listing one and the two other create backends**,
then **10–11, replay and the scoped leaderboard**. Three sittings, as its own
appendix predicted, and each left the tree green. 0009–0014 depend on none of
them.

Each plan carries its own argument. The two that span the series are written
where they bite hardest: which changes owe a version bump, in 0001; what the
immutable genesis forces every later change to be, in 0009.
