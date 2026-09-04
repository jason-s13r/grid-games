# Changelog

## protocol@0.5.0 (2026-09-04)

### Features

- an empire is the people in it
  Bot teammates in a solo game and bot seats inside a human empire were both a
  host arranging its own side some extra hands. In a multiplayer lobby that is
  not a feature, it is an unfair setup with a UI.

  So a seat in a human empire is a person who is there, and another one joins the
  way a substitute always has: ROSTER_AMEND, endorsed by a quorum of the empire
  already holding the seats. A headless bot is seated by exactly that route.
  Deterministic SimBot empires are untouched — a default opponent is the one kind
  of bot a lobby should be composing.

  The seat cap replaces them, refused a layer earlier each time: checkPlan while
  the host can still fix it, inspectGenesis for a record born oversized, and the
  simulation for the amendment. Only the last is load-bearing.

  The lobby loses the keypairs it minted for bot seats, and with them the hub
  that divided one connection between several drivers. A page runs one seat.

### Dependencies

- sim: 1.1.0 -> 2.0.0


## protocol@0.4.0 (2026-09-01)

### Features

- let a snapshot carry the roster it belongs to
  A snapshot carries the simulation, and the simulation knows members by
  index and nothing about keys. A peer that adopted one across a roster
  amendment held a state with a seat in it and no idea whose key sat there,
  and rejected that player's every move afterwards. The same peer waited
  forever on seats the rest of the game had dropped, because an ejection is
  network state and never appears in a snapshot either.

  The frame now carries the amendment and drop records themselves rather
  than a summary of them, so the receiver re-checks every quorum for itself.
  A snapshot stays safe to take from anyone, which is the property that lets
  an untrusted archive peer be useful without being trusted.

- count an amendment's endorsements
  verifyAmendment answered yes or no, but a peer has to act on a record that
  is not finished yet: one valid signature is what separates a real proposal
  from a stranger's noise, and only the first is worth holding a step open
  for. tallyAmendment returns how many distinct seats have signed and how
  many it takes, and verifyAmendment is now a comparison of the two.

  mergeAmendment joins two partial tallies the way mergeDrop does, so peers
  gossiping what each has collected converge without anyone counting for
  everyone else.


## protocol@0.3.0 (2026-09-01)

### Features

- team chat nobody else can read
  The mesh broadcasts everything, so privacy here has to be cryptographic
  rather than a matter of who a message is addressed to. An opponent, an
  observer and an archive peer all receive every team message and store
  it; what separates them from a teammate is only whether the bytes open.

  A random content key per message encrypts the text, and that key is
  wrapped once per teammate under a secret derived by ECDH between the
  sender's keypair and theirs — the same keypairs the roster already names
  everyone by. Nobody has to be online to receive a key, nothing has to be
  stored, no new record type exists, and a member seated later by
  amendment can be written to immediately.

  Web Crypto fixes the algorithm at generation, so an ECDSA key can sign
  and nothing else. But a P-256 point is a P-256 point, and the keypair
  can be exported and read back as ECDH — checked in Node and in Chrome
  before anything was built on it. Using one keypair twice is safe here
  because the uses are separated: ECDSA signs domain-tagged payloads, and
  every derived secret goes through HKDF salted with the game id and
  tagged with the empire, so a secret derived for one thing can never be
  made to serve another.

  It is fanout rather than a group key, which is the honest trade. N
  teammates costs N-1 wraps of sixty bytes, nothing at the size a team
  actually is, and it avoids a group agreement that P-256 cannot do
  without a live participant to distribute it. The cost is that there is
  no single team key to publish afterwards, so the plan's optional
  post-game reveal is not something this construction can offer.

  What it deliberately does not hide is who is talking. A team line is
  signed and attributable like every other record, so an opponent sees
  that empire 2's second seat said something at 3:20 and can read the
  traffic even without the words. The panel marks those lines rather than
  dropping them: a message you cannot open still tells you it happened.

### Fixes

- a reload is not equivocation
  The equivocation slot was keyed on (empire, member, seq). A seq counter
  lives in one Lockstep instance and restarts at zero when a player
  reloads, so a returning seat honestly re-spends numbers its peers still
  remember — and every one of them read that as the member contradicting
  itself. The accusation is broadcast, the seat is ejected, and because
  the accusing peer drops the move instead of applying it while the mover
  applied it locally, the table desyncs on the way out.

  Key the slot on the step as well. Nothing is lost: ordering within a
  step is by (empire, member, seq), so a duplicated pair is exactly the
  ambiguity that could diverge two peers, and that pair is still caught.
  Reusing a seq at a different step decides nothing — both moves are
  gossiped, both apply at their own steps, and every peer lands on the
  same state.


## protocol@0.2.0 (2026-08-31)

### Features

- genesis, member identity and signed wire records
  The root of trust for Phase C. A genesis record hashes to the game id;
  an ECDSA P-256 keypair is a member; every move, message, checkpoint and
  amendment is signed over a canonical binary payload bound to that game
  id and domain-separated by record type.

  Three properties the 65-check harness pins down:

    * Attribution comes from the roster seat, never from a key carried
      beside the signature — "valid for the key it names" proves nothing.
    * Fields are range-checked before encoding, so two different moves can
      never share a payload through truncation.
    * decodeFrame returns null rather than throwing on anything a peer
      sends, and signatures are verified over bytes rebuilt from parsed
      fields rather than over the bytes that arrived.
