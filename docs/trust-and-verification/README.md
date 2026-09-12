# Trust and verification

What an attacker can and cannot do, and how a game's history is kept in a form a
stranger can check.

| Page | Covers |
|---|---|
| [trust-model.md](trust-model.md) | The complete list of what an attacker cannot do, and the two things they can |
| [archive-format.md](archive-format.md) | `ArchivedGame`, and the on-disk `log.jsonl` / `head.json` / `snapshots/` layout |
| [verifying-an-archive.md](verifying-an-archive.md) | `verifyArchive` — re-hash, rebuild, check every signature, replay to the claimed hash |
| [leaderboard.md](leaderboard.md) | `rankArchives` — a derivation, not a record; the refusal rules |
| [resume points](../continuity/resume-points.md) | The second checkable artifact: a snapshot carrying signed witnesses, for a game nobody is left in |
