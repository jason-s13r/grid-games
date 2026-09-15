# The bot

[`apps/bot`](../../apps/bot) (`tessera-bot`) is a headless peer that holds **one
seat** — night cover for an empire whose players are asleep. The empty seat keeps
answering ([heartbeats](../continuity/heartbeats-and-liveness.md), promises
[readiness](../continuity/lockstep.md)), so it never blocks the peers still
playing.

It is a [PeerBot](../gameplay/bots.md): its own mesh client, its own key, signing
and broadcasting moves like any player. It runs [`PeerBot`](../../packages/net/src/peerbot.ts)
around a [`Lockstep`](../continuity/lockstep.md) built by
[`joinGame`](headless-peers.md).

## Seated like any substitute

With `--apply <empire>` it asks that empire for a seat and starts playing as soon
as the seats already there agree. Without it, it joins as an
[observer](observer.md), prints the key it holds, and waits for somebody to paste
that key into an invitation — the older path, and the reason `--apply` exists.

Either way the empire decides, by a quorum of the seats already there, and
**there is no bot-shaped mechanism in the protocol**. It costs the empire a seat,
which is the whole price
([empires-and-seats.md](../gameplay/empires-and-seats.md)).

The request stands rather than fires once: it is re-signed on a slow timer, so it
reaches members who connect later, and it withdraws itself within a minute if the
process dies ([applications](../continuity/joining.md)). A refusal is the absence
of an answer rather than a record, so there is nothing for the bot to handle and
nothing for it to retry — it keeps asking while the empire has room.

## What is not configurable

- **How fast it acts** — floored at `botActionInterval` (2 s). An always-on seat
  that out-reflexed the people it plays against is the one thing night cover must
  never be. Slower is a choice; faster is refused.
- **Its population ceiling** — `popMax` is hashed state, set by whoever seated
  it. A bot may play *weakly*; it cannot play *strongly*. (The `--level` profile's
  `popMax` is ignored for a PeerBot; only its phase durations and tempos apply.)

A `BOT` seat is **not** otherwise discounted — it accrues like a person and its
coins chain like a person's. An old design charged it (half accrual, a 499 cap):
"a discounted player is not an easier one, it is a worse one."

## It defends by default

A night-shift bot that attacked would take ground its team never chose to take,
on a front nobody was awake to hold. Pinned to `defend` it reinforces the
thinnest contested tile and nothing else — no expand, no coin grabs, and with no
line to hold it banks for the morning. Cover, not initiative — a default, not a
limit.

## Flags

```
tessera-bot <room> [options]
  --key <path>     identity file, default ./bot.jwk — the key IS the seat
  --apply <n>      ask empire n for a seat, and keep asking while it is open
  --as <id>        claim a specific peer id (ignored on a socket ref)
  --ice <urls>     STUN/TURN, replacing PeerJS's own
  --quiet
  --level <how>    easy | steady (default) | hard   — the --play cycle's phases/tempos
  --play <how>     defend (default) | expand | attack | fortify | heal | sleep | cycle
  --target <who>   nearest (default) | random | rotate | <empire number>
  --rate <how>     brisk (2 s) | steady (15 s, default) | patient (85 s) | <seconds>
  --hours <a-b>    only play between local hours, e.g. 22-07 (wraps midnight)
  --duty <on/off>  play <on> min in every <on+off>, e.g. 20/40
```

`--target` `random`/`rotate` change only every ~2 minutes
(`ROTATE_STEPS`) — a bot that re-chose every action would just be `nearest` with
extra steps. `awake()` requires **both** `--hours` and `--duty` to be satisfied;
a resting bot stays connected and banks. All flags are validated up front — a bad
flag is a refusal at the prompt, not a surprise an hour into a game.

`PeerBot` is tested in
[`peerbot.test.ts`](../../packages/net/src/test/peerbot.test.ts): "a bot covers a
seat and every peer still agrees"; "a bot seat accrues exactly like the human
beside it"; "deciding doesn't advance the sim's RNG"; "a resting bot keeps
answering and keeps its seat".
