# The observer

[`apps/observer`](../../apps/observer) (`tessera-observe`) is a **durable,
seatless peer**: it validates every move, hashes every step and stores
everything, and cannot act. That has been true in the browser since an
[observer](../concepts/peers-and-roles.md) is just a peer with no roster key —
the app puts a long-lived process around it on a small VPS so a multi-day game
survives everyone sleeping.

It holds no seat, its checkpoint vote counts like anyone's, and every frame it
forwards was signed by somebody else. It **cannot cheat, because it has nothing
to cheat with**.


## It asks for nothing

An observer holding a key *could* apply for a seat — that is what the
[application](../continuity/joining.md) record is for — and an archiving observer
should not. Its value is that it holds no seat: nobody waits for it, it blocks
nothing, and the archive it writes is the one artefact in the game nobody had a
stake in. A keeper that played would be a player with a filing cabinet.

`--apply` is the [bot](bot.md)'s flag for that reason, not this one.

## The stable address

Room codes are [peer ids](../mesh/webrtc-mesh.md), so a game whose host has
closed their laptop is reachable only at whatever peer is still up. `--as <id>`
gives the observer a stable id — it becomes the door back into a game that would
otherwise have none.

## The observer and the host peer are the same peer

[`tessera-host`](host-peer.md) is this program with a door on it: both hold no
seat, both archive, both are observers by construction. The difference is what else
they do — a host composes the genesis, relays the room, and serves its archive and
[resume point](../continuity/resume-points.md) over HTTP.

Run an observer to watch and archive a game somebody else is hosting. Run a host
peer when the game needs somewhere to *be*: a room that outlives the tab that
started it, and a URL a dormant game can be re-entered through.

## Four subcommands

```
tessera-observe <room> [options]           follow a game and write it down
tessera-observe export <dir> [file.json]  assemble an archive directory into one JSON file
tessera-observe verify <dir | file.json>  check an archive end to end (exit 1 on REFUSED)
tessera-observe rank <dir>                the leaderboard, from every archive under dir
```

`<room>` is a [connection reference](../mesh/connection-refs.md) — a room code or
a room link — so a string that was never a room fails at the prompt rather than
being dialled for 45 seconds. (`tessera-observe ./archives/abc`, the mistake of
forgetting `verify`, used to do exactly that.)

Options for `follow`: `--dir` (default `./archives`), `--key` (default
`<dir>/identity.jwk`), `--as <id>`, `--ice <urls>` (replaces PeerJS's relays),
`--quiet`.

A socket ref needs no `--ice` — there is no ICE to configure — and loads no
native WebRTC at all, which is the difference between an install that works on a
small VPS and one that does not.

`--as` warns rather than fails when given an id outside the room charset: such an
id can be claimed at a broker and then never typed back into a join box, which
defeats the point of asking for a stable one. It is ignored on a socket ref,
where the room bus stamps the sender itself.

## follow

[`watch(ref)`](../../apps/observer/src/main.ts#L69):
[`identityAt`](headless-peers.md) → [`joinGame`](headless-peers.md); in
`onDriver`, create a [`FileArchive`](../trust-and-verification/archive-format.md)
at `<dir>/<gameId>/`, `attach` it to the driver, `open()`. Logs `onEjection` and
`onHalt` — an observer is the one peer likely to be watching when something goes
wrong and the only one nobody is sitting in front of. Prints progress every 60 s;
`SIGINT`/`SIGTERM` → `archive.close()` + `peer.stop()`.

## verify / rank

`verify` runs [`verifyArchive`](../trust-and-verification/verifying-an-archive.md)
and prints `VERIFIED` / `REFUSED`. `rank` gathers every game folder and loose
`.json` under a directory (naming and skipping any that will not read), runs
[`rankArchives`](../trust-and-verification/leaderboard.md), and prints the table
**plus the refusals**. A game counts once however many observers archived it; two
observers on one game is the normal way to keep an archive safe.
