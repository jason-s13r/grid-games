# Changelog

## bot@0.2.0 (2026-10-30)

### Features

- night cover as a WebSocket client
  tessera-bot holds one seat in an online game while its player is away. It
  joins from a game link, redeeming the invite in it or asking an empire
  with --ask, keeps its key in bot.jwk, and simulates on its own clock like
  a browser does. It plays the shared targeting policy with its own
  randomness, defends by default, and never acts faster than the game's
  floor for bots. --play, --level, --target, --rate, --hours and --duty
  carry over from the mesh-era bot.

### Dependencies

- sim: 2.0.0 -> 4.0.0
- protocol: 0.5.0 -> 1.0.0
- room: 0.0.0 -> 1.0.0
