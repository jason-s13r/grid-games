# Move encoding

[`encodeMove`](../../packages/protocol/src/records.ts#L69) produces the exact
bytes that get signed. The signer and every verifier build these bytes the same
way, from parsed fields — a signature is **never** verified over the bytes that
arrived, only over bytes rebuilt from the fields the parser accepted.

```
"tessera/move/1" ‖ u16 len(gameId) ‖ gameId
                 ‖ u32 step ‖ u32 seq
                 ‖ u8 empire ‖ u8 member ‖ u8 type ‖ u8 reserved(0)
                 ‖ u16 x ‖ u16 y
```

The record body is exactly 16 bytes ([`Writer(16)`](../../packages/protocol/src/records.ts#L71)).
The `reserved` byte keeps it 4-byte aligned if it ever grows. The preamble
(`preamble()`, [`records.ts:37`](../../packages/protocol/src/records.ts#L37)) is
`utf8(tag) ‖ u16 length ‖ gameId`.

## The three properties

Every signed record — not just moves — carries these, and each is load-bearing
([`records.ts:4`](../../packages/protocol/src/records.ts#L4)):

### 1. A domain tag

`"tessera/move/1"`. A signature over a move can never be replayed as a signature
over a [chat message](../protocol/team-chat.md) (`"tessera/message/1"`), a
[checkpoint](../continuity/desync.md), a [drop](../continuity/leaving-and-drops.md),
or a [handshake](../continuity/joining.md) — the tagged payloads simply do not
collide. [`records.test.ts`](../../packages/protocol/src/test/records.test.ts)
holds "a move sig ≠ a message sig".

### 2. The game id

A move signed in one game cannot be replayed into another — including a game an
attacker generated for the purpose, whose id would differ.

### 3. Fixed-width, range-checked fields

Two different moves can never encode to the same bytes, so they can never share a
signature. [`moveInRange`](../../packages/protocol/src/records.ts#L55) rejects
anything out of range **before** the encoder is reached, on both sides — a field
wider than its slot would silently truncate. It checks: `step`/`seq` are u32,
`empire` is u8 and `>= 1`, `member`/`type` are u8, `type` is a known `MOVE`
value, `x`/`y` are u16.

## The signed / verified pair

| Function | Does |
|---|---|
| [`signMove(identity, gameId, move)`](../../packages/protocol/src/records.ts#L84) | `{ move, sig }` where `sig` is base64url IEEE-P1363 `r‖s` |
| [`verifyMove(roster, gameId, signed)`](../../packages/protocol/src/records.ts#L95) | well-formed **and** in range **and** the signature is that roster seat's key. Says nothing about whether the *rules* allow the move — that is [`validate`](validation.md)'s job. |

Signatures are **randomised** (ECDSA): two peers signing the same move produce
different bytes. Harmless, because signatures are never hashed into state.
