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

## Running a board

Anything that serves JSON qualifies. The client does the verifying, so a board
needs no logic about games at all — see
[the address book](../mesh/address-book.md) for the row shape, the one rule a
board should enforce about writes (`verifyWrite`), and why a static file is a
read-only board.

A [host peer](host-peer.md) announces itself with `--announce <url>` and keeps
its own row alive.

## What is not here yet

- **Listing a game from the browser.** A tab can read a board; it cannot yet
  announce one. Host a game from a [host peer](host-peer.md) with `--announce` to
  put it on a board today.
- **Replay and the leaderboard.** Both are in plan 0008 and neither is built.
