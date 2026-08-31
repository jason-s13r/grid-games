// Tessera — browser client.
//
// Local play against SimBots for now. The sim is driven exactly as the Phase C
// lockstep driver will drive it: moves in, dirty tiles out, camera and DOM
// strictly outside the simulation.

import { seedFrom } from "@tessera/sim";
import { LocalGame } from "./game/Local.js";
import { Camera, MIN_ZOOM, MAX_ZOOM, DOM_MIN_ZOOM } from "./view/Camera.js";
import { MapImage } from "./view/MapImage.js";
import { Renderer } from "./view/Renderer.js";
import { Minimap } from "./view/Minimap.js";
import { Controls } from "./view/Controls.js";
import { injectThemeCss } from "./view/palette.js";
import { MOVE } from "@tessera/sim";

const pick = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
};

injectThemeCss();

const viewportEl = pick<HTMLDivElement>("[data-viewport]");
const tilesEl = pick<HTMLDivElement>("[data-tiles]");
const lodEl = pick<HTMLCanvasElement>("[data-lod]");
const minimapEl = pick<HTMLCanvasElement>("[data-minimap]");

const MAP = { width: 160, height: 112 };

let game: LocalGame;
let camera: Camera;
let mapImage: MapImage;
let renderer: Renderer;
let minimap: Minimap;
let controls: Controls;

function start(seed: number): void {
  game = new LocalGame({ seed, bots: 3, teammates: 0, ...MAP });

  camera = new Camera(MAP.width, MAP.height);
  mapImage = new MapImage(MAP.width, MAP.height);
  renderer = new Renderer(tilesEl, lodEl, camera, mapImage);
  minimap = new Minimap(minimapEl, camera, mapImage, MAP.width, MAP.height);
  controls = new Controls(game, {
    you: pick<HTMLElement>("[data-you]"),
    standings: pick<HTMLElement>("[data-standings]"),
    clock: pick<HTMLElement>("[data-clock]"),
    banner: pick<HTMLElement>("[data-banner]"),
    zoomhint: pick<HTMLElement>("[data-zoomhint]"),
  });

  mapImage.paintAll(game.sim.state);
  centred = false;
  resize();
}

/** Opening on your own capital needs a laid-out viewport: centring against a
 *  zero width just parks the camera in the corner. Defer until the first
 *  non-empty measurement, which is also the first ResizeObserver callback. */
let centred = false;

function resize(): void {
  const rect = viewportEl.getBoundingClientRect();
  camera.resize(rect.width, rect.height);

  if (!centred && rect.width > 0 && rect.height > 0) {
    const capital = game.sim.state.empires[game.empire - 1]!.capital;
    camera.centreOn(capital % MAP.width, Math.floor(capital / MAP.width));
    centred = true;
  }
}

new ResizeObserver(() => resize()).observe(viewportEl);

// --- input -------------------------------------------------------------------

let dragging = false;
let dragMoved = 0;
let lastX = 0;
let lastY = 0;

viewportEl.addEventListener("pointerdown", (event) => {
  dragging = true;
  dragMoved = 0;
  lastX = event.clientX;
  lastY = event.clientY;
  viewportEl.setPointerCapture(event.pointerId);
});

viewportEl.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  const dx = event.clientX - lastX;
  const dy = event.clientY - lastY;
  lastX = event.clientX;
  lastY = event.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  camera.panByPixels(dx, dy);
});

viewportEl.addEventListener("pointerup", (event) => {
  dragging = false;
  viewportEl.releasePointerCapture(event.pointerId);
  // A drag is a pan, not a click.
  if (dragMoved > 4) return;

  const rect = viewportEl.getBoundingClientRect();
  const [x, y] = camera.tileAt(event.clientX - rect.left, event.clientY - rect.top);
  if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;

  if (controls.placeMode === "bridge") game.act(MOVE.PLACE_BRIDGE, x, y);
  else if (controls.placeMode === "ladder") game.act(MOVE.PLACE_LADDER, x, y);
  else game.claim(x, y);
});

viewportEl.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const rect = viewportEl.getBoundingClientRect();
    camera.zoomAt(
      event.clientX - rect.left,
      event.clientY - rect.top,
      event.deltaY < 0 ? 1.12 : 1 / 1.12,
    );
  },
  { passive: false },
);

pick<HTMLButtonElement>('[data-action="pause"]').addEventListener("click", (event) => {
  const btn = event.currentTarget as HTMLButtonElement;
  if (game.running) {
    game.pause();
    btn.textContent = "Resume";
  } else {
    game.resume();
    btn.textContent = "Pause";
  }
});

pick<HTMLButtonElement>('[data-action="new"]').addEventListener("click", () => {
  tilesEl.replaceChildren();
  start(seedFrom(String(Date.now())));
});

// --- loop --------------------------------------------------------------------

let minimapDue = 0;

function frame(now: number): void {
  const dirty = game.tick();
  renderer.render(game.sim.state, dirty.size > 0 || camera.changed ? dirty : null);

  // The minimap does not need 60fps.
  if (now >= minimapDue) {
    minimap.render(game.sim.state);
    controls.render(game.sim.state);
    controls.setZoomHint(
      camera.zoom >= DOM_MIN_ZOOM
        ? `${Math.round(camera.zoom)}px per tile — drag to pan, scroll to zoom`
        : `${Math.round(camera.zoom)}px per tile — zoom in past ${DOM_MIN_ZOOM}px for detail`,
    );
    minimapDue = now + 200;
  }

  requestAnimationFrame(frame);
}

start(seedFrom("tessera"));
requestAnimationFrame(frame);

Object.assign(window as unknown as Record<string, unknown>, {
  tessera: {
    get game() { return game; },
    get camera() { return camera; },
    MIN_ZOOM,
    MAX_ZOOM,
  },
});
