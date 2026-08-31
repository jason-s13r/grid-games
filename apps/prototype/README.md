# Prototype (frozen)

The original single-player Empire Attack prototype that Tessera grew out of.
Kept verbatim as a visual and behavioural reference — in particular the
conic-gradient "flag" tile art in `tessera.scss`, which the new renderer
carries forward.

**Do not develop this further.** It uses the old `cells[x][y]` model that packed
owner and population into one signed integer, which is exactly what
`@tessera/sim` replaced. New work belongs in `apps/web`.

Run it with `pnpm --filter @tessera/prototype dev` if you want to compare
behaviour.
