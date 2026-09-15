# Finding a game

How to play with somebody you have not already sent a room code to.

Until the [address book](../mesh/address-book.md) there was one answer: host a
game, copy the code, send it to a person. That still works and is still the
shortest path. This page is about the other one.

## The short version

1. Open the web client and expand **Settings**.
2. Put an address book URL in the **Address book** field.
3. Games other people have listed appear in the **Games** card above.
4. Press **Join** on one. Your browser checks the game before it plays it.

There is no default board and none ships with this client. That is deliberate:
a board is a URL that arrives the way a room code used to, and bundling one
would make this client's author the operator of the place every game is
announced to. Somebody gives you a board, or you run one — a static JSON file
behind any HTTP server is a legitimate board for a group of friends.

## What a row says, and which half you can believe

A board is **allowed to lie**. Everything on a row is either re-derived from the
sealed [genesis record](../protocol/genesis.md) that came with it, or it is a
claim the board made — and the card never renders one as the other.

| On the row | Where it comes from |
|---|---|
| "3 empires · 160×112" | the record |
| "3 hours", "2:14:09 left" | the record's [duration rules](../gameplay/durations.md) and your own clock |
| "seats open for 41:02" | the record's join window; it disappears when the window shuts |
| "4 seats, 1 empty" | counted off the roster in the record |
| "the board says 3 are in use" | **the board**, and worded so you can tell |
| "Witnessed at step 41,200 by 3 of the 3 seats it needs" | signatures from that game's own seats |
| "No witnesses yet" | nobody has vouched for it. Not a reason to hide it |

Rows whose genesis does not hash to the id they claim never reach the card at
all — [`Directory`](../mesh/address-book.md) drops them before a view sees them.

**Witnesses are the only line a stranger cannot manufacture.** Anyone with a
keypair can compose ten thousand well-formed records, and every one of them will
pass every check except that one. A row with a quorum of its own seats signing
*(step, hash)* is a game. A row without them is a rumour, and both are shown —
hiding the unproven ones would hide every game composed in the last five
minutes, which are exactly the games a board is most needed for.

**A game this build cannot play is shown, not hidden.** It says which version it
needs. A lobby that silently omits the game you are in is the worst possible
answer.

## Joining a row is not joining a code

A code you were sent came from a person who had just been told what was behind
it. A row **names a game**, and that is a new way to be wrong.

Post a row for somebody's real game id, with their real sealed record, and refs
pointing at a relay you control. Every check passes — the record is genuine. A
reader dials your relay, meets a room you own, and is handed whatever record you
like, composed correctly.

So a click on a row carries `expect: <that game's id>` into
[`Lobby.open`](../mesh/the-lobby.md), and arriving at a different game fails with
*"that room is running a different game"* instead of quietly starting one. A code
typed into the join box carries no expectation, because there is nobody to have
lied to you.

## Knocking, and what happens when nobody is home

Pressing Join does not dial blindly. [`resolve`](../mesh/address-book.md) knocks
on each door the row lists, in the order they were announced, and one of three
things comes back.

- **Somebody answered.** You join, with `expect` set.
- **Nobody answered, but a quorum signed for a state.** The row offers to take
  the game up, and shows the tally first — *"Nobody is there. Endorsed by 3 of
  the 3 seats it needs, at step 41,200."* You decide with that in front of you,
  not after. Committing opens a room of your own and puts the game back up in it
  at that step, via [`Lobby.revive`](../mesh/the-lobby.md).
- **Nothing at all.** Every reason is listed — which door did not answer, whether
  the clock ran out, whether a resume point was short of signatures — and the
  button becomes *Try again*, because a host that is rebooting is worth another
  knock in a minute.

The knock happens when you click, never while the list is drawn. Probing a ref
opens a connection, which over WebRTC pulls the whole broker client down; doing
that for every row would cost a page load per game nobody was interested in.

## Three things a browser cannot do

These are the client's alone. No other peer in Tessera is subject to them.

**A page on `https` cannot open a `ws://` room, or read an `http://` board.**
The browser blocks both before a byte leaves and reports a `TypeError` with
nothing in it. The refs are fine — [0003 accepts `ws://`](../mesh/connection-refs.md)
on purpose, for a LAN, a Tailscale address, a host on `127.0.0.1`, and a
[headless peer](headless-peers.md) beside you joins one happily. It is the *page*
that cannot, so the client says so where the reason is still known: in the join
box, and in the settings field. The same client served from `http://localhost`
by `pnpm dev` accepts both.

**A board that blocks this page looks exactly like a board that is down.**
CORS failures are opaque by design. The card says "could not read that board"
and prints the URL it tried, rather than "no games" — which would be a lie in
both cases and unfixable in one.

**A tab is not a process.** Nothing a browser does on close is guaranteed: a
phone swiped away, a crashed tab and a closed laptop lid all skip `beforeunload`.
So a row's TTL is the mechanism and any withdrawal is a courtesy. A board's
freshest possible answer is "as of one heartbeat ago", which is why `resolve`
dials instead of believing it.

## Listing a game of your own

The **List this game publicly** box on the create form, off by default, with a
sentence saying what it sends rather than what it is called. It posts the room
code and the sealed record to your configured board — and the sealed record
carries every member key in the roster, which is every player's stable public
identity. That is a disclosure about other people, not a display preference, so
it is asked rather than assumed.

Nothing else differs between a listed game and an unlisted one. Same record,
same room, same checks by every peer. It is a checkbox and not a mode.

**A tab may only list a door it is actually holding.** The box appears when you
are hosting in this tab and nowhere else:

| How you got here | What your tab lists |
|---|---|
| Hosting in this tab, over WebRTC | your room — your peer id *is* the room code |
| Joined somebody's room | nothing. The door is theirs and already on the board |
| A room a [host service](#starting-a-game-somewhere-else) made | nothing, same reason |
| A solo game | nothing. There is no door |

The row is refreshed every ninety seconds and carries whatever witnesses have
accumulated since the last one, so a game that reaches its first checkpoint stops
being a rumour without anybody doing anything. Leaving withdraws it. Closing the
tab tries to, and the TTL is what actually removes it — see *A tab is not a
process* above.

## Starting a game somewhere else

Three ways to start a multiplayer game, one artifact. Whichever you use, the
record is composed in your browser and checked by everybody who plays it.

1. **This tab.** Today's model, always available. Your browser is the room, and
   the game ends when you close it.
2. **A host peer's room.** Paste the ref a [host peer](host-peer.md) printed. If
   that room has no game running in it yet, your tab offers to set one up; the
   host keeps the door open and keeps writing the log down.
3. **A host service.** Put a URL in **Host service** in Settings and a third
   button appears on the create screen. It asks the service for a room and joins
   it, and from there it is case 2.

Cases 2 and 3 are the same path, and that is the design: a service is a doorman
and never a referee. What it hands back is a set of refs, which is the same
thing a friend sends you in a message, so a service that hands back the wrong
room hands back a room that refuses you.

**Two people in one empty room can each start a game.** Your tab offers to
compose only while the room reports no game running — which closes the common
case, arriving somewhere a game is already under way — but two people who arrive
at an empty room in the same minute can still each seal a record, and each peer
plays whichever one reached it first. A disabled button is a convention, not a
rule. The rule is co-signed composition, which is plan 0009. Until then, if you
are both looking at the same empty room, agree who presses it.

There is no host service to point this at. Nothing in Tessera builds one: what
ships is the request shape (`POST <service>/rooms`, `{protocol, plan}` in,
`{refs}` back) so that anyone who wants to run one has something to implement
against.

## Running a board

Anything that serves JSON qualifies. The client does the verifying, so a board
needs no logic about games at all — see
[the address book](../mesh/address-book.md) for the row shape, the one rule a
board should enforce about writes (`verifyWrite`), and why a static file is a
read-only board.

A [host peer](host-peer.md) announces itself with `--announce <url>` and keeps
its own row alive.

## Watching one that already happened

**Save log** in a running game hands you the whole thing: the genesis record,
every signed move, and the hash they produce. **Watch a saved game** on the menu
is the other end of it, for your own logs or somebody else's.

Your browser checks the file before it shows you anything — every signature
against the roster the genesis record builds, and the whole log replayed to see
whether it reaches the state the file claims. A log that fails says everything
that was wrong with it and never becomes scrubbable. A log that begins in the
middle (a peer who joined an hour in holds a fragment) says that too, because it
cannot be replayed from the start.

Scrubbing backwards works, which is less obvious than it sounds: the simulation
has no undo, so going back is going forward from a snapshot kept on the way
through. A long game has coarse snapshots and a seek across one takes a moment —
the strip says so rather than pretending.

## The leaderboard

Built the same way and from the same files: **Add saved games**, or list archive
URLs in Settings — a [host peer](host-peer.md) serves the log of a game it kept
at `/room/<room>/archive`. Every figure is read out of hashed state after the log
has been replayed here, so nothing in the table was reported by anybody.

What did not get counted is printed beside it, named by the file it came from. A
leaderboard that silently drops what it could not check is one nobody can audit,
which would give back exactly what the signatures were for.

It is scoped to what you have, and says so. There is no index of finished games
anywhere in Tessera — a board holds live doors and drops the row when the last
one closes — so a public, cross-host table is a plan and not a setting.

## What is not here yet

- **A game composed together.** Until plan 0009, whoever presses start seals the
  record alone, which is why the paragraph above asks two people in one room to
  agree between themselves.
- **An index of finished games**, which is what a leaderboard covering more than
  your own files would need.
