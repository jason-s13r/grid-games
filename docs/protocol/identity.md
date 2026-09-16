# Identity

[`Identity`](../../packages/protocol/src/identity.ts#L63) is an **ECDSA P-256**
keypair, and the **public key is the member**. Wherever a seat is named — the
genesis roster, an amendment, the UI — it is named by its key.

## P-256, not Ed25519

Purely because Ed25519 support in browser Web Crypto is still patchy. P-256 is
available everywhere the game runs, Node included, with no library. Signatures
are IEEE-P1363 `r‖s`, a flat 64 bytes (`SIGNATURE_BYTES`), base64url on the wire.

## MemberKey

`type MemberKey = string` ([`identity.ts:33`](../../packages/protocol/src/identity.ts#L33))
— base64url of the 65-byte uncompressed public-key point (leading `0x04`). This
string is the member id everywhere.

## Signatures are randomised

Two peers signing the same move produce **different** bytes. This is harmless and
worth stating plainly because it looks exactly like a desync: signatures are
never hashed into simulation state — only [moves](../moves/the-move-record.md)
are, and a move is the same on every peer.

## The API

| Member | Does |
|---|---|
| `Identity.generate()` | a fresh keypair |
| `Identity.restore(jwkString)` | reload from `export()`; **returns null** on anything malformed (the caller is usually reading `localStorage`, where corruption is routine) |
| `export()` | JWK string, for persistence — **losing it loses the seat**, since the roster names the key |
| `sign(payload)` | base64url signature over the bytes |
| `agreementKey()` | the same keypair re-imported as ECDH — see below |
| `verify(key, sig, payload)` | free function; **never throws** — a bad key, a truncated signature and a genuine forgery all mean the same thing |
| `fingerprint(key)` | 8 hex chars of the key's SHA-256 — to tell teammates apart in the UI, **never for authorisation** |

Imported verifying keys are cached by string form, **including negative results**
([`identity.ts:192`](../../packages/protocol/src/identity.ts#L192)), so a peer
spamming garbage keys cannot make everyone re-run `importKey` on each one.

## One keypair, two algorithms

Web Crypto fixes the algorithm at generation — an ECDSA key can only sign. But a
P-256 point is a P-256 point, so the keypair is exported and read back as **ECDH**
for [team chat](team-chat.md), giving two teammates a shared secret from the very
keys the roster already names them by — no second keypair to distribute, persist,
or lose.

Safe because the two uses are cryptographically separated: ECDSA signs
domain-tagged payloads; every ECDH-derived secret goes through HKDF with its own
tag ([`secrets.ts:50`](../../packages/protocol/src/secrets.ts#L50)). Neither can
be made to produce something the other would accept.

## name#fingerprint

A `MemberKey` is unreadable and a `fingerprint(key)` is eight hex characters,
which tells two strangers apart and is useless for playing with people you know.
A [naming](signed-records.md) puts a word in front of it.

**The suffix is not optional.** Nothing stops two players choosing `kestrel`
and nothing should: uniqueness needs an authority to arbitrate, and there is no
authority anywhere in this system by design. So the name is never shown alone —
`kestrel#a3f19c04` is the rendering, the eight hex characters are the identity,
and **impersonation is made visible rather than prevented**. A chat line may
abbreviate to the prefix where the seat colour already disambiguates; the roster,
the rivals panel and every join or endorsement prompt show the full form.

**Every string off the wire is filtered before it is rendered.** `escape()`
replaces `&`, `<`, `>` and `"` and nothing else, which is enough against
injection and useless here: a name containing U+202E passes through it untouched
and reverses the rendering of everything after it on the line — *including the
fingerprint that was supposed to make impersonation visible*. So `cleanName`
strips the control, bidi and zero-width classes, normalises to NFC, collapses
whitespace and truncates to 64 bytes on a code point boundary, and it runs on the
**reader's** side. Input validation is worth nothing here: the sender is
untrusted and a hostile client does not run ours.

The cap is in bytes because "24 characters" is three different numbers — UTF-16
units, bytes, grapheme clusters — and only the encoder's can be the wire's.
