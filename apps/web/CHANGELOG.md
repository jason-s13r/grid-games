# Changelog

## web@0.2.1 (2026-08-31)

### Fixes

- keep the workspace protocol on the sim dependency
  autoVersion rewrote workspace:* to ^0.2.0, which unlinks the package
  from the workspace and leaves pnpm-lock.yaml recording a specifier the
  manifest no longer declares, so the deploy's --frozen-lockfile install
  refused to run. Constrain the rewrite to workspace ranges and write them
  back as they were; package versions are still stamped.


## web@0.2.0 (2026-08-31)

### Features

- add map controls and fix tile alignment when zooming
  Zooming was visibly broken. reconcile() repainted live tiles but only
  ever set a transform in acquire(), so on a zoom every tile already on
  screen kept its old pixel position while taking the new size: tiles sized
  30px sitting on a 24px grid, each overlapping its neighbour, with the map
  crammed into a fraction of the viewport. Positions are now recomputed for
  every tile in range whenever the zoom changes, and left alone on a pan,
  where translating the one container is still enough.

  Zoom is also a ladder of whole pixels per tile rather than a continuous
  multiplier. Fractional zoom meant fractional tile sizes and therefore
  sub-pixel seams across the grid, and it made a step mean something
  different every time. Whole numbers keep every edge crisp and make a step
  mean the same thing from a button, a key or a wheel notch.

  Wheel handling now spends at most one rung per event and drops the
  remainder instead of banking it. A single mouse notch reports ~100px, so
  scaling by the raw delta made one flick skip several levels, which is
  what made zooming hard to aim.

  Adds on-screen pan arrows, zoom buttons, a centre-on-capital control and
  arrow/+/-/H keyboard equivalents. The controls sit over the viewport,
  which captures the pointer to drive panning, so pointerdown on them is
  ignored — capture would otherwise redirect the gesture and the buttons
  would never see their own click.

  The topbar now shows the built version and the sim's protocol number,
  read from the manifest that dispat rewrites on release.

- add the client with virtualised viewport and minimap
  Drives the simulation the way the lockstep driver will: moves in, dirty
  tiles out, camera and DOM strictly outside the simulation. Swapping local
  play for the mesh changes where moves come from, not how the game runs.

  The map is arbitrarily large, so one image of the whole map at one pixel
  per tile backs both the zoomed-out view and the minimap. Drawing is then
  one drawImage regardless of zoom or map size, and staying current costs
  one pixel write per changed tile.

  Close in, real DOM tiles carry the prototype's conic-gradient flag art,
  generalised to N empires by swapping --c1/--c2. Elements are pooled and
  recycled, and panning translates one container rather than every tile.
  The prototype ran a querySelector per cell per frame; this touches only
  tiles the simulation reports dirty.

  Not Leaflet: it is built for raster tile pyramids from a tile server and
  assumes tiles are static images, where here every cell can change on any
  step.

### Dependencies

- sim: 0.1.0 -> 0.2.0
