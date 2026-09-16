# 0012 — Names and direct messages: the social layer that never touches the hash

Status: built (2026-09-16)
Depends on: nothing
Branch: `names`, then `direct-messages` — split as the appendix recommends

## The problem

Two gaps with one answer.

**Nobody has a name.** A player is eight hex characters of their key's digest
— `fingerprint(key)`, cached into `LobbyPlayer.label`
(`packages/net/src/lobby.ts:206`), and falling back to the first eight
characters of a peer id when even that has not resolved. It is enough to tell
two strangers apart and useless for playing with people you know.

**You can only talk to your own team or to everyone.** `CHANNEL` is
`{ PUBLIC: 0, TEAM: 1 }` (`packages/protocol/src/records.ts:111`). There is no
way to say one thing to one person, which in a game about annexing your
neighbours is the conversation that matters most.

## The single principle

Both belong to the class of things that are **signed and attributable but
never hashed into state**. That class already exists and its charter is
written at `records.ts:114`:

> Ordered, signed and attributable — but never hashed into state. That is the
> whole reason chat is safe: a message that arrives late, out of order, or not
> at all cannot cause a desync.

A display name must be in that class and not in the world. If a name were a
consensus input, then a peer that missed a rename would render a different
game, a name would be a griefing surface with a hash attached, and every
rename would be a step in the log. It is a label, so it lives where labels
live.

## Names

A new record, one per rename, ignored by the simulation entirely:

```ts
// tag: tessera/name/1
export interface Naming { step: number; seq: number; empire: number; member: number; name: string; }
export interface SignedNaming { naming: Naming; sig: string; }
```

Verified exactly as a message is — `roster.keyOf(empire, member)`, so a name
is a claim only its seat can make (`records.ts:171`). The latest `(step, seq)`
from a seat wins; earlier ones are forgotten like chat lines.

### The display form is `name#fingerprint`, and the suffix is not optional

Nothing stops two players choosing `master5o1`, and nothing should: uniqueness
would need an authority to arbitrate, and there is no authority anywhere in
this system by design (`docs/mesh/the-lobby.md`). So the name is never shown
alone. `master5o1#a3f19c04` is the rendering, the eight hex characters are the
identity, and impersonation is therefore visible rather than prevented.

The UI may abbreviate to `master5o1` in a chat line where the seat colour
already disambiguates, but the roster, the rivals panel and any join or
endorsement prompt show the full form. **Every screen where a decision is made
shows the fingerprint.**

Constraints, all local and none of them consensus: 24 characters, no control
characters or bidi overrides, trimmed, rendered with `textContent` and never
`innerHTML` — the rule `Chat.ts:8` already states for message bodies applies
to every string that came off the wire, and a name is one.

### Before there is a game

In the lobby there is no game id to sign against, so `HelloFrame` gains an
optional `name` that proves nothing at all — the same standing as the key it
already carries, which is "a claim, not yet a fact"
(`packages/protocol/src/wire.ts:43`). The lobby panel shows it beside the
fingerprint and the plan says out loud that a lobby name is unverified. Once
genesis exists, seats re-assert their names as signed records and the claim
becomes attributable.

## Direct messages

`CHANNEL` gains `DIRECT: 2`. **No change to the `Message` record** — `channel`
is a `u8` and `messageInRange` already accepts any value in range
(`records.ts:132`).

The recipient is not a field, because the envelope already carries it.
`packages/protocol/src/secrets.ts` seals a message with a random content key
wrapped once per recipient by ECDH over the keypairs the roster already names
everyone by. A team message is that with N-1 wraps. **A direct message is that
with one.**

### Trial decryption, and the property it buys

A wrap currently carries a member index so a teammate can find its own
(`secrets.ts:36`). A DM leaves it out and every peer simply tries the one wrap
against its own derived key. At a realistic roster size that is a handful of
ECDH operations per message, and it means the wire shows *that* a seat spoke
privately and not *to whom*.

So the honest statement, matching the one `secrets.ts:22` already makes about
team chat: **a direct message hides the words and the recipient. It does not
hide that you spoke.** Every peer stores the ciphertext, and an archive of the
game contains every DM anyone ever sent, unreadable.

### The derivation has to lose the empire

`wrappingKey` binds its HKDF info to the use, the game *and the empire*, so
that "two members on two empires in two games share four unrelated keys"
(`secrets.ts:54`). A DM has two empires, or one, or crosses to an observer, so
that binding cannot be used as-is.

Envelope version 2: identical layout, wrapping key derived over the game id
plus **both member keys in lexicographic order**, which both ends compute
identically without agreeing on anything. `open()` dispatches on the leading
version byte, so every v1 team message ever sealed keeps opening forever.

### Refusing them

Local, and only local. `ChatPanel` already holds a mute set keyed
`empire:member` and argues the case for it at `Chat.ts:12`:

> Muting lives here and only here. It is a decision about what this reader
> wants to see, so it needs no agreement, no log entry and no record type.

Rejecting DMs is the same decision with a channel filter on it. There is no
"blocked" record, no notification to the sender, and no way for two peers to
disagree about state as a result. A sender whose DMs are being discarded
learns that the way people always have: no reply.

## Versioning

Nothing here is hashed, so `PROTOCOL_VERSION` and `LAYOUT_VERSION` are
untouched. An older peer receiving a `channel: 2` message fails to verify or
fails to open it and drops it — chat is explicitly allowed to be lossy — and
receiving a naming frame gets `null` from `decodeFrame`. A mixed mesh loses
names and DMs, not agreement.

The secrets envelope constant `VERSION` (`secrets.ts:30`) goes 1 → 2, and it
is the only version number in the tree this plan moves.

## Verification

- `packages/protocol/src/test/naming.test.ts`: a naming verifies against its
  seat and fails against another's; the latest `(step, seq)` wins; a 25th
  character, a control character and an RTL override are all refused.
- `packages/protocol/src/test/secrets.test.ts` gains: a v2 DM opens for its
  recipient, does not open for anyone else including the sender's own
  teammates, and **the wire bytes do not name the recipient** — asserted by
  showing two different recipients produce indistinguishable envelope shapes.
- Every existing v1 team-chat vector still opens under the v2 dispatch. This
  is the compatibility tripwire and it is a stored fixture, not a regenerated
  one.
- `packages/web` chat suite: a muted DM channel drops lines without affecting
  the driver; two peers muting differently hold identical state.

---

# Implementing it

A plan of action for 0012, written after reading the code it names. Every line
number below was checked against the tree at `docs` HEAD.

The single principle holds, and it holds for a stronger reason than the body
gives. `gameIdOf` hashes the whole genesis minus its own id
(`genesis.ts:41-43`), so a `name` field on `MemberSpec` would be inside the
game id: renaming would be impossible, and two peers with different names for
one seat would not merely render differently, they would compute different game
ids and never meet. The body says a name "must be in that class and not in the
world"; the code says it could not be in the world even if someone wanted it
there. Use the stronger argument.

Everything else worth saying is about the crypto, and the lead finding is a
sentence in the Versioning section that reads like bookkeeping and is not.

## What ships

| File | Change |
|---|---|
| `packages/protocol/src/secrets.ts` | `sealDirectBody`, `openDirectBody`, pair-derived `wrappingKey`, per-version wrap layout, a derived-key cache |
| `packages/protocol/src/records.ts` | `CHANNEL.DIRECT`, the widened `Channel` type, `Naming`, `SignedNaming`, `TAG_NAMING`, `encodeNaming`, `signNaming`, `verifyNaming`, `nameInRange` |
| `packages/protocol/src/names.ts` | new — `cleanName`, the reader-side filter; `Names`, the latest-wins store |
| `packages/protocol/src/wire.ts` | `FRAME.NAME`, `NameFrame`, one `decodeFrame` case, `name?` on `HelloFrame` |
| `packages/protocol/src/index.ts` | exports |
| `packages/protocol/src/test/vectors/` | new — two exported JWKs, a fixed game id, one stored v1 envelope |
| `packages/net/src/lockstep.ts` | `say(body, channel, to?)`, the DM branch in `read`, `rename`, `nameOf`, `names()`, `onNamed`, the naming store and its re-assert |
| `packages/net/src/lobby.ts` | `name` on the outgoing hello, on `LobbyPlayer`, and in `players()` |
| `apps/web/src/net/identity.ts` | persist the display name beside the key |
| `apps/web/src/view/Chat.ts` | the DM filter at `:152`, the recipient picker, `name#fingerprint` on a line |
| `apps/web/src/view/LobbyPanel.ts` | names in the roster, the waiting list and the endorsement prompt |
| `apps/web/src/main.ts` | `:466` — stop saying "someone" |
| docs | five files, below |

## The lead finding: version 2 is not a bump, it is a second scheme

The body's Versioning section ends:

> The secrets envelope constant `VERSION` (`secrets.ts:30`) goes 1 → 2, and it
> is the only version number in the tree this plan moves.

Read that against what the section above it asks for. A team message's wrapping
key binds HKDF `info` to `tessera/team/1:${empire}` (`secrets.ts:76`), and the
comment at `:50-55` is explicit about why:

> Two members on two empires in two games therefore share four unrelated keys,
> and a secret derived here can never coincide with one derived for anything
> else.

A DM cannot use that binding — the body is right — so v2 derives over the pair
of keys instead. But `VERSION` is a single module constant read by
`sealTeamBody` at `:134` and checked by `openTeamBody` at `:153`. Move it to 2
and **every team message starts sealing under the pair derivation too**, which
silently deletes the empire binding the comment at `:50` exists to defend, and
makes a team message between two people identical in key material to a DM
between the same two people. The property the comment claims is then false, and
nothing in the suite would notice.

`VERSION` does not move. **A second value is added**, and the byte selects a
scheme rather than a generation:

| Byte | Scheme | Derivation | Wrap | Sealed by |
|---|---|---|---|---|
| 1 | team | game id + `tessera/team/1:${empire}` | `member`, nonce, wrapped key — 61 bytes | `sealTeamBody`, unchanged |
| 2 | direct | game id + both keys, lexicographic | nonce, wrapped key — 60 bytes | `sealDirectBody`, new |

Which means `WRAP_BYTES` and `HEADER_BYTES` (`secrets.ts:35-36`) stop being
constants and become functions of the leading byte, and `openTeamBody` /
`openDirectBody` are two entry points over one dispatcher rather than one
function with a branch. That is more code than "1 → 2" implies and it is the
shape that keeps the existing argument true.

Restate the sentence as: **this plan moves no version number at all.** It adds
an envelope scheme, and every other version constant in the tree —
`PROTOCOL_VERSION` (`sim/src/constants.ts:8`), `LAYOUT_VERSION`
(`sim/src/state.ts:20`), `ARCHIVE_FORMAT` (`net/src/archive.ts:25`) — is
untouched, the last one because `verifyArchive` runs `verifyMessage` over
archived chat (`archive.ts:296`) and a `channel: 2` message verifies exactly
like any other: `channel` is a `u8` in the signed bytes and `messageInRange`
already accepts the whole range (`records.ts:132-142`). The body is right that
`Message` needs no change; it is worth saying *why* it needs none in terms of
the archive, because that is the artefact that would have forced a format move.

## The v1 fixture the plan leans on does not exist

> Every existing v1 team-chat vector still opens under the v2 dispatch. This is
> the compatibility tripwire and it is a stored fixture, not a regenerated one.

There is no stored vector anywhere in the tree, and the fixture module cannot
produce one. `fixture()` calls `Identity.generate()` four times on every
invocation (`test/fixture.ts:30-35`), and `sealTeamBody` draws a fresh content
key and two random nonces per message (`secrets.ts:109-122`). Every run of
`secrets.test.ts` seals a brand-new envelope under brand-new keys. Re-running
the suite after changing the derivation would go on passing, because the thing
it opens was sealed by the same code five milliseconds earlier.

This is the one test in the plan that cannot be written from what exists, and
it is also the most load-bearing, because **archives already hold v1 bodies**:
`ArchivedGame.messages` is every `SignedMessage` as it crossed the wire, and
its own comment says a team line "stays ciphertext here exactly as it was to
every peer but its recipients" (`archive.ts:41-43`). `openTeamBody` is the only
thing that will ever read those again.

Building the vector is not hard, and it is a prerequisite rather than a
follow-up:

- Two keypairs exported via `Identity.export()` — the same serialisation
  `apps/web/src/net/identity.ts:23` already persists to `localStorage` — and
  committed as JSON.
- A fixed game id string. Not a sealed genesis: the vector should not break
  when `makeGenesis` gains a default.
- One base64url envelope, sealed once by today's code and pasted in, with a
  comment saying which commit produced it and that it is never to be
  regenerated.

Do this **before** touching `secrets.ts`, on the code as it stands. A vector
generated after the change proves nothing.

## Eleven things the body assumes that the code does not do

1. **`say` has nowhere to put a recipient.** `say(body, channel = PUBLIC)`
   (`lockstep.ts:504`) and `ChatHooks.send(body, channel)` (`Chat.ts:32`) both
   need a third argument, and `submit()` at `Chat.ts:124-129` has no idea who
   the reader meant. A DM is not a channel you select; it is a channel plus a
   person, and the two-`Option` `<select>` at `Chat.ts:74-77` cannot express
   that. Worse, the obvious gesture is taken: clicking a name in a chat line
   currently **mutes** them (`Chat.ts:174-179`).
2. **`read()` short-circuits on the wrong empire.** `if (!seat || !identity ||
   seat.empire !== message.empire) return null` (`lockstep.ts:705`) is exactly
   backwards for a DM, which arrives from an arbitrary empire and must be
   attempted anyway. Reorder the branch on channel first.
3. **A DM cannot be addressed to an observer.** The body says a DM "crosses to
   an observer", but `Lockstep` has no key directory outside the roster — every
   lookup in the file goes through `roster.keyOf`. `Lobby.members` is a
   `Map<string, MemberKey>` of peer id to key (`lobby.ts:83`), but it belongs
   to the lobby, is populated from lobby hellos, and the driver never sees it.
   **Scope DMs seat-to-seat and say so.** The alternative is a key directory,
   which is a plan of its own and overlaps 0011's applications.
4. **An observer cannot have a verified name either**, for the same reason:
   `Naming` is verified through `roster.keyOf` like a message
   (`records.ts:171`). A seatless peer's only name is the unverified hello one,
   which means `name#fingerprint` for an observer is *always* the unverified
   form. That is defensible and it needs saying, because "the claim becomes
   attributable once genesis exists" is only true for people with seats.
5. **`fingerprint` is asynchronous and every panel renders synchronously.** The
   lobby already carries the workaround and the comment explaining it
   (`lobby.ts:98-100`: "Deriving one is async and the panel renders
   synchronously, so they are cached as they arrive"). "Every screen where a
   decision is made shows the fingerprint" therefore means every such screen
   needs a resolved cache, not a call. Put one cache in one place and hand
   panels strings.
6. **`escape()` is not a name sanitiser.** `LobbyPanel.ts:39` replaces `&`,
   `<`, `>` and `"` and nothing else. A name containing U+202E passes through
   it untouched and reverses the rendering of everything after it on that
   line — **including the fingerprint that was supposed to make impersonation
   visible.** The bidi and control-character filter has to be its own function,
   applied before the string reaches either `escape()` or `textContent`.
7. **"Never `innerHTML`" is not what the tree does.** `Chat.ts` uses
   `textContent`; `LobbyPanel.ts` and `Rivals.ts` build template strings and
   call `escape()`. Both are safe against injection. State the rule as it is —
   *escaped or textContent, and filtered either way* — rather than as a rule
   the panel that will show names first already breaks.
8. **The constraints must be enforced by the reader.** "Constraints, all local
   and none of them consensus" reads as input validation, and input validation
   is worth nothing here: the sender is untrusted, and a hostile client simply
   does not run it. Truncation, trimming, the control-character filter and NFC
   normalisation all happen on the way *in* from the wire. The input field's
   `maxLength` is a courtesy.
9. **"24 characters" is three different numbers.** `String.length` counts
   UTF-16 units, `encodeNaming` needs a byte cap for its length prefix the way
   `encodeMessage` does (`records.ts:145-158`), and what a reader sees is
   grapheme clusters. Pick the wire cap in bytes, normalise to NFC before
   measuring, and let the UI cap what it likes.
10. **"The latest `(step, seq)` wins" has no tiebreak.** Two namings signed by
    one seat at one `(step, seq)` with different names are not a desync — a
    name is not hashed — but they are a permanent UI split, with two peers
    showing different names for the same person for the rest of the game.
    Moves have `EquivocationWatch` for exactly this (`records.ts:578-596`) and
    it covers moves only. Break the tie on the signature bytes: total, cheap,
    and needs no proof record.
11. **`FRAME.NAME` is missing from the design.** The Versioning section says
    "receiving a naming frame gets `null` from `decodeFrame`", which is only
    true once a frame exists to be null about. It is one `FRAME` member, one
    interface, one `decodeFrame` case — the switch already falls through to
    `return null` on anything unrecognised (`wire.ts:255`) and both carriers
    drop a null frame silently (`mesh.ts:267-268`, `hub.ts:125-126`), so the
    degradation claim checks out.

## Trial decryption is one derivation, and it happens on every peer

The body says trial decryption is "a handful of ECDH operations per message".
It is one, and the cost is not where the sentence puts it.

There is exactly one candidate key: ECDH is symmetric, so against a given
sender a reader can derive precisely one wrapping key. Nothing is tried against
a range of recipients — the reader derives its own and sees whether the tag
verifies. So the per-message cost is one `deriveBits`, one HKDF `deriveKey` and
one AES-GCM attempt.

The part worth measuring is *who pays*. Today `read()` returns before any of
that unless the message is on our own empire (`lockstep.ts:705`), so a peer
does ECDH only for its own team's traffic. A DM has no empire to filter on:
**every peer attempts every DM in the game, including ones between two
opponents.** The attacker economics are mild but real — one seal costs the
sender one derivation and costs each of N peers one derivation — and it lands
on the serial verification lane, which exists precisely so that frames from one
peer cannot overtake each other (`lockstep.ts:314-317`). A burst of DMs from
one peer queues derivations ahead of that peer's next READY.

`agreementPublicKey` already caches its imports for exactly this class of
reason (`identity.ts:135-149`). Follow it: memoise the derived AES key by
`(counterpart key, scheme)`. It is a pure function of the pair and the game id,
the driver holds one game, and it turns N derivations per counterpart into one.
After that a DM costs one AES-GCM attempt, which is free.

## Chat already decided the question the DM section reopens

The DM section's honest statement is that the wire shows *that* a seat spoke
privately. `Chat.ts` has already been through this argument once and reversed
itself, and the comment at `:140-149` records the reversal:

> ...used to be shown as a sealed line — the argument being that knowing an
> exchange happened is part of reading the game. In play it is not: it is a
> stranger's private conversation announcing itself in your log, several times
> a minute, saying nothing. **Traffic analysis is not a feature anybody asked
> for.**

So the UI answer is settled and the plan should cite it rather than re-derive
it: a DM this reader could not open is dropped outright, like another empire's
team line. But note that it does not happen by itself — the filter at
`Chat.ts:152` is

```ts
if (message.channel === CHANNEL.TEAM && message.empire !== this.you?.empire) return;
```

which a `channel: 2` message from another empire **passes**, and it would then
render as "sealed to their empire" (`:186`) on every peer in the game. That
line has to be edited, not extended, or DMs become precisely the noise the
comment above it says was removed.

The corollary is that `text === null` stops being sufficient to classify a
line. Today it means "our team, unopenable". With DMs it means either that or
"not for us", and only `channel` separates them.

## A name is not a seat

`Naming` is keyed `{ empire, member }`, and so is muting (`Chat.ts:44-46`), and
so is `Lockstep.seating`. For the driver that is correct — a seat is what signs
things. For a *name* it is wrong, and the tree already knows why in two places.
`Chat.close()` clears the mute set with the comment "A new game is a new
roster: empire 2 seat 1 is somebody else next time" (`Chat.ts:105`). And
`eject`'s comment says a returning player "is seated again by ROSTER_AMEND at a
fresh index" (`lockstep.ts:1090`).

So within one game, a seat index is not stable across a drop and a return, and
a name stored under `empire:member` follows the chair rather than the person.
The signed record should keep naming the seat — that is what `verifyMessage`'s
construction can check — but **the store is keyed by `MemberKey`**, resolved
through `roster.keyOf` at the moment the record verifies. Then `name#fingerprint`
is keyed by the same thing the fingerprint is derived from, and a player who is
dropped and re-seated keeps their name for free.

Two consequences worth writing down:

- **Muting should move to the key too**, or a muted player is unmuted by
  reconnecting. That is a pre-existing hole, not one this plan opens, but this
  is the plan that makes it visible.
- **A naming broadcast once is lost to anyone who connects later.** Chat can
  afford that — a missed line scrolls away — but a name is persistent UI state,
  so a peer that missed the record shows a bare fingerprint for the rest of the
  game and never recovers. `Transport` has no connection hook to hang a
  re-send on: `id`, `peers`, `broadcast`, `send`, `listen`, and nothing else
  (`transport.ts:14-21`). Two cheap answers, and they compose: repeat our own
  naming on a slow timer, the way `READY_REPEAT_MS` exists because "a full mesh
  takes a second hop to form" (`lockstep.ts:137-144`); and answer a naming from
  a key we have not seen before with our own, which terminates because it fires
  only on first sight.

Names are also **per game**, because the record is signed against a game id.
Nothing persists them: `apps/web/src/net/identity.ts` holds the keypair and
that is all. Your own name belongs beside it in `localStorage`, and other
people's belong in the address book 0007 is building — otherwise every player
renames themselves at the start of every game, which nobody will do twice.

## Two clauses missing from the honest statement

The body offers:

> **a direct message hides the words and the recipient. It does not hide that
> you spoke.**

That is the right register — it is the one `secrets.ts:22` already uses — and
it is two clauses short of true.

**It does not survive a key compromise, retroactively.** The construction is
static-static ECDH with no ephemeral component and no ratchet, so the wrapping
key between two members is a deterministic function of two long-term keypairs.
Anyone who obtains either private key later can open every DM either party ever
sent or received, from any archive, forever. Team chat has the same property
and it matters less there, because nobody believes a message to four teammates
is a secret. A DM is the message people will assume is safer than it is, so the
statement has to carry the clause.

**It does not open for its own sender.** The recipient list excludes the
sender, and `secrets.test.ts:46-49` asserts that on purpose. Live, the UI hides
it: `say()` calls `onMessage(message, body)` with what was typed
(`lockstep.ts:549-551`). But on reload, on resume, and in every archive, your
own half of a DM conversation is a blank. Team chat has the same hole and it
reads as an inconvenience; a two-person conversation with every other line
missing reads as broken.

There is a fix that costs nothing and strengthens the recipient-hiding claim
rather than weakening it: **a v2 envelope always carries exactly two wraps**,
the recipient's and the sender's, ordered by the same lexicographic rule the
derivation uses. The sender's own wrap derives under the pair rule with both
keys being theirs, so it needs no special case. The envelope shape is then
*constant* — two wraps, always, whoever it is for — which is a stronger
indistinguishability property than "one wrap" gives, and a reader tries two
AES-GCM opens against its one derived key instead of one. The plan's own
verification then gets easier to write: two different recipients produce
byte-length-identical envelopes because every v2 envelope is.

## Order of work

**Split the branch.** Names and DMs share a principle and no code. Names need
no crypto, unblock 0014's roster screen and 0011's endorsement prompt, and can
land in a session. DMs need the envelope scheme, the vector and the cache. One
`social-layer` branch means the cheap useful half waits for the expensive half.

| # | Step | Half | Green? |
|---|---|---|---|
| 1 | The v1 vector: two exported JWKs, a fixed game id, one sealed envelope, committed, with the "never regenerate" comment. On today's `secrets.ts`. | DM | yes |
| 2 | `cleanName` and its tests — NFC, trim, control and bidi strip, byte cap. Pure function, no callers yet. | name | yes |
| 3 | `Naming`, `encodeNaming`, `signNaming`, `verifyNaming`, `nameInRange`; the `Names` store keyed by `MemberKey` with the signature tiebreak. | name | yes |
| 4 | `FRAME.NAME`, the `decodeFrame` case, `name?` on `HelloFrame`, the exports. | name | yes |
| 5 | `Lockstep.rename` / `nameOf` / `onNamed`, the slow re-assert and the first-sight answer. | name | yes |
| 6 | Lobby: `name` on the hello, on `LobbyPlayer`, in `players()`. Persist our own beside the key. | name | yes |
| 7 | UI: the resolved `name#fingerprint` cache, the lobby roster, the waiting list, `main.ts:466`. **Names are usable here.** | name | yes |
| 8 | `secrets.ts`: version dispatch, per-scheme wrap layout, the derived-key cache. No new scheme yet — v1 still the only value, and step 1's vector is the check. | DM | yes |
| 9 | The v2 scheme: pair derivation, two wraps, `sealDirectBody` / `openDirectBody`. | DM | yes |
| 10 | `CHANNEL.DIRECT`, the widened `Channel`, `say(body, channel, to)`, the `read()` reorder. | DM | yes |
| 11 | `Chat.ts`: the `:152` filter, the recipient picker, DM rendering. | DM | yes |
| 12 | Docs. | both | yes |

Step 8 before step 9 is the point of the ordering: refactor the dispatch while
there is still only one scheme, so the vector is testing the refactor rather
than the refactor and the new scheme together.

## Docs

| File | What changes |
|---|---|
| `docs/protocol/team-chat.md` | The scheme byte, the pair derivation, the two-wrap envelope, and the retroactive-compromise clause |
| `docs/protocol/signed-records.md` | `Naming` — attributable, never hashed, latest-wins with a tiebreak |
| `docs/protocol/the-wire.md` | `FRAME.NAME`, `HelloFrame.name` and what an unverified lobby name is worth |
| `docs/protocol/identity.md` | `name#fingerprint`, why the suffix is not optional, and that no authority arbitrates the prefix |
| `docs/mesh/the-lobby.md` | A lobby name proves nothing — the same standing as the key beside it (`lobby.ts:209-212`) |
| `docs/clients/web-client.md` | Where the name is set and where it is stored |
| `docs/trust-and-verification/archive-format.md` | Every DM ever sent is in the archive, unreadable, permanently |

## Verification, mapped to files

| Claim | Where it is checked |
|---|---|
| **a stored v1 envelope still opens after the change** | `secrets.test.ts` against the committed vector. The tripwire, and the reason step 1 is first |
| **a team message's key still binds the empire** | seal the same text for the same pair on empire 1 and empire 2; the wraps differ. This is the assertion that would have caught `VERSION` moving to 2 |
| a v2 DM opens for its recipient | `secrets.test.ts` |
| and for its sender | the two-wrap change; today's suite asserts the opposite at `:46-49`, so that test moves rather than being deleted |
| and for nobody else, including the sender's teammates | `f.carol` on the same empire gets null |
| the envelope does not name the recipient | two different recipients, byte-length-identical envelopes, no member byte anywhere in the wrap region |
| a name verifies against its seat and fails against another's | `naming.test.ts`, mirroring `records.test.ts`'s message cases |
| the latest `(step, seq)` wins, and ties break deterministically | two records at one slot fed in both orders produce the same name |
| a 25th character, a control character and an RTL override are refused | `cleanName` unit tests — **on the reader's side**, fed strings that never went through an input field |
| a name survives a drop and a re-seat | the store is keyed by `MemberKey`; seat the same key at a fresh index and the name follows |
| a peer that joins late learns existing names | the re-assert. Fails today with a single broadcast |
| a DM this peer cannot open never reaches the log | `Chat.ts`'s filter, not the driver's |
| two peers muting differently hold identical state | `agreed(t)` — the existing chat suite already has the shape |
| the wrapping key is derived once per counterpart | count `deriveBits` calls across 50 DMs from one sender |
| an old build drops a name frame and keeps playing | `agreed(t)` with one peer whose `handle` has no `FRAME.NAME` case |
| no version number moved | `PROTOCOL_VERSION`, `LAYOUT_VERSION` and `ARCHIVE_FORMAT` have no diff |

## What came out differently

Written after building it. The appendix was right about its lead finding and
right about the eleven, and it was right to split the branch — names landed
first and whole, on `names`, and the envelope work on `direct-messages` after
it. Five things it did not have.

**The vector had to be generated from `dist`, not from the suite.** Step 1 says
to seal one envelope with today's code and commit it, which is correct and is
not something a test can do for you: a script that imports the source would be
re-sealing under whatever the source says at the moment it runs, which is the
tautology the vector exists to break. It was generated by a one-off script
against the built `packages/protocol/dist` at the commit before the envelope
changed, and the directory carries a README saying never to regenerate it. The
vector then stayed green across the scheme refactor, which is the whole of its
job.

**The two-wrap envelope makes the sender's own DMs readable, and that needed a
map the plan does not mention.** The appendix's fix is right — a v2 envelope
carries the sender's wrap too, so the shape is constant and a conversation is
not half blank. But reading our own line back requires knowing *which
counterpart to derive against*, and the record deliberately does not say. So
`Lockstep` keeps a local `seq → recipient` map, sent nowhere, lost on reload
like the rest of a scrollback. Without it the sender holds a wrap it cannot
address.

**`Channel` did not need widening.** The "what ships" table lists "the widened
`Channel` type". It is `(typeof CHANNEL)[keyof typeof CHANNEL]`, so adding
`DIRECT: 2` to the object widened it already — and `messageInRange` accepts any
`u8`, which is the same fact from the other end. The record really did not
change at all.

**The recipient picker went into the channel select, and the appendix's own
"does not settle" is why.** Step 11 asks for a picker; the closing section says
this plan should hand 0014 "the driver API and a strong opinion, not a widget",
and notes that the obvious gesture — clicking a name — is already bound to
muting. Both hold if the people go into the control that already chooses where a
line is going: one option per seated peer, no new gesture, and nothing for 0014
to unlearn when it rebuilds the panel.

**A public `Lockstep.key`.** Listing who can be written to means leaving
ourselves off the list, and `options.identity` is private. One getter beside
`seat`, which is the same shape of question.

And one thing the tree taught rather than the plan: **`pnpm typecheck` checks
against built `dist` types**, so it has to follow `pnpm build` or it validates
stale declarations. Vitest transpiles without type-checking, so a green suite is
not evidence the tree compiles. Both halves of this plan were written against
that mistake once before it was noticed.

## What this plan does not settle

- **Whether a DM can reach a seatless peer.** The recommendation here is no,
  and the cost is that the people most likely to want to talk privately —
  someone asking for a seat (0011), someone watching — cannot. A key directory
  would fix it and belongs with 0011 or 0007, not here.
- **How a DM is started.** Clicking a name is the obvious gesture and it is
  already bound to muting. 0014 rebuilds these panels; this plan should hand it
  the driver API and a strong opinion, not a widget.
- **Whether names appear in an archive.** They are signed records with a game
  id, so they could be, and an archive that renders `master5o1#a3f19c04`
  instead of eight hex characters is a better artefact. Nothing in
  `ArchivedGame` holds them today and adding a field is an `ARCHIVE_FORMAT`
  move — which is why it is not in this plan.
- **Whether the two-wrap envelope should be the team scheme too.** It would
  give a sender their own team lines back on reload. It is a bigger change to a
  working thing and it can wait for evidence that anyone minds.
- **The re-assert interval.** Guessed against `READY_REPEAT_MS`. The real
  constraint is how long a newcomer stares at hex.
