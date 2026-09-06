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

## The stable address

Room codes are [peer ids](../mesh/webrtc-mesh.md), so a game whose host has
closed their laptop is reachable only at whatever peer is still up. `--as <id>`
gives the observer a stable id — it becomes the door back into a game that would
otherwise have none.

## Four subcommands

```
tessera-observe <room-code> [options]     follow a game and write it down
tessera-observe export <dir> [file.json]  assemble an archive directory into one JSON file
tessera-observe verify <dir | file.json>  check an archive end to end (exit 1 on REFUSED)
tessera-observe rank <dir>                the leaderboard, from every archive under dir
```

Options for `follow`: `--dir` (default `./archives`), `--key` (default
`<dir>/identity.jwk`), `--as <id>`, `--ice <urls>` (replaces PeerJS's relays),
`--quiet`.

## follow

[`watch(code)`](../../apps/observer/src/main.ts#L68):
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
