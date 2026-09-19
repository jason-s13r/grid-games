# Clients

The programs that join a game. None of them decides anything about the rules —
they [render and take input](web-client.md), or they run a
[headless peer](headless-peers.md) on a timer.

| Page | Covers |
|---|---|
| [web-client.md](web-client.md) | `apps/web` — the browser client; renders and takes input, decides nothing |
| [headless-peers.md](headless-peers.md) | `packages/headless` — a peer with no browser: WebRTC under Node, a key in a file, an archive on disk |
| [observer.md](observer.md) | `apps/observer` — a durable, seatless peer that keeps a game alive and writes it down |
| [host-peer.md](host-peer.md) | `apps/host` — the same peer with a door: it composes a game, relays the room, and serves what it keeps |
| [bot.md](bot.md) | `apps/bot` — a headless peer that holds one seat as night cover |
| [finding-a-game.md](finding-a-game.md) | how to play with somebody you have not sent a room code to — the address book from a player's side |
| [api-service.md](api-service.md) | `apps/api` — a board somebody can point a client at, and the list of what it refuses to decide |

`apps/prototype` is the original single-player game, frozen. Nothing depends on
it, and it is out of scope here.
