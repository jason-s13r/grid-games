# Changelog

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
