// Tessera — browser client.
//
// Local play against SimBots for now. The sim is driven exactly as the Phase C
// lockstep driver will drive it: moves in, dirty tiles out, camera and DOM
// strictly outside the simulation.

import { seedFrom, PROTOCOL_VERSION, Sim } from "@tessera/sim";
import { Roster } from "@tessera/protocol";
import { Lockstep } from "@tessera/net";
import pkg from "../package.json";
import { LocalGame } from "./game/Local";
import { OnlineGame } from "./game/Online";
import type { Driver } from "./game/Driver";
import { Lobby, myIdentity } from "./net/Lobby";
import { LobbyPanel } from "./view/LobbyPanel";
import { ChatPanel } from "./view/Chat";
import { Camera, MIN_ZOOM, MAX_ZOOM, DOM_MIN_ZOOM } from "./view/Camera";
import { MapImage } from "./view/MapImage";
import { Renderer } from "./view/Renderer";
import { Minimap } from "./view/Minimap";
import { Controls } from "./view/Controls";
import { injectThemeCss, empireTheme } from "./view/palette";
import { MOVE } from "@tessera/sim";

const pick = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
};

injectThemeCss();

// Version comes from the manifest, which dispat rewrites on release, so what
// the UI shows is whatever was actually built. The protocol number is the one
// that decides whether two peers can play together at all.
document.querySelector("[data-version]")!.textContent =
  `v${pkg.version} · protocol ${PROTOCOL_VERSION}`;

const viewportEl = pick<HTMLDivElement>("[data-viewport]");
const tilesEl = pick<HTMLDivElement>("[data-tiles]");
const lodEl = pick<HTMLCanvasElement>("[data-lod]");
const minimapEl = pick<HTMLCanvasElement>("[data-minimap]");
const lobbyEl = pick<HTMLDivElement>("[data-lobby]");
const chatEl = pick<HTMLDivElement>("[data-chat]");

/** The solo map. A mesh game uses whatever its genesis says, so this is
 *  replaced when a game is mounted rather than assumed by the view. */
const SOLO_MAP = { width: 160, height: 112 };
let MAP = { ...SOLO_MAP };

let game: Driver;
let camera: Camera;
let mapImage: MapImage;
let renderer: Renderer;
let minimap: Minimap;
let controls: Controls;

function start(seed: number): void {
  mount(new LocalGame({ seed, bots: 3, teammates: 0, ...SOLO_MAP }));
}

/** Everything downstream of here is the same for a solo game and a mesh game —
 *  the driver interface is the whole of the difference. */
function mount(driver: Driver): void {
  game = driver;
  MAP = { width: driver.sim.state.width, height: driver.sim.state.height };
  tilesEl.replaceChildren();

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
    centreOnCapital();
    centred = true;
  }
}

new ResizeObserver(() => resize()).observe(viewportEl);

// --- input -------------------------------------------------------------------

let dragging = false;
let dragMoved = 0;
let lastX = 0;
let lastY = 0;

/** The map controls sit on top of the viewport, and the viewport captures the
 *  pointer to drive panning. Capture redirects the rest of the gesture to the
 *  capturing element, so without this the buttons never see their own click. */
const onControls = (event: Event): boolean =>
  !!(event.target as HTMLElement).closest(".mapctl");

viewportEl.addEventListener("pointerdown", (event) => {
  if (onControls(event)) return;
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
  if (onControls(event)) return;
  if (!dragging) return;
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

// Wheel deltas are wildly inconsistent — a mouse notch is ~100px, a trackpad
// emits a stream of small ones, and some devices report lines instead. Rather
// than scaling zoom by each delta (which makes trackpads lurch), accumulate and
// spend one ladder step per notch-worth of scrolling.
const WHEEL_NOTCH = 60;
let wheelAccum = 0;

viewportEl.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
    wheelAccum += pixels;

    // At most one rung per event, and drop the remainder rather than banking
    // it: a single mouse notch reports ~100px, so spending every accumulated
    // notch made one flick skip two or three zoom levels.
    if (Math.abs(wheelAccum) < WHEEL_NOTCH) return;
    const direction = wheelAccum < 0 ? 1 : -1;
    wheelAccum = 0;

    const rect = viewportEl.getBoundingClientRect();
    camera.zoomStep(direction, event.clientX - rect.left, event.clientY - rect.top);
  },
  { passive: false },
);

// --- map controls ------------------------------------------------------------

const PAN_FRACTION = 0.35;

function centreOnCapital(): void {
  const capital = game.sim.state.empires[game.empire - 1]!.capital;
  camera.centreOn(capital % MAP.width, Math.floor(capital / MAP.width));
}

pick<HTMLElement>(".mapctl").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("button");
  if (!button) return;

  switch (button.dataset.pan) {
    case "up": return camera.panByViewport(0, -PAN_FRACTION);
    case "down": return camera.panByViewport(0, PAN_FRACTION);
    case "left": return camera.panByViewport(-PAN_FRACTION, 0);
    case "right": return camera.panByViewport(PAN_FRACTION, 0);
    case "home": return centreOnCapital();
  }
  if (button.dataset.zoom === "in") camera.zoomStep(1);
  if (button.dataset.zoom === "out") camera.zoomStep(-1);
});

window.addEventListener("keydown", (event) => {
  if (event.target instanceof HTMLInputElement) return;
  const handled = true;
  switch (event.key) {
    case "ArrowUp": camera.panByViewport(0, -PAN_FRACTION); break;
    case "ArrowDown": camera.panByViewport(0, PAN_FRACTION); break;
    case "ArrowLeft": camera.panByViewport(-PAN_FRACTION, 0); break;
    case "ArrowRight": camera.panByViewport(PAN_FRACTION, 0); break;
    case "+": case "=": camera.zoomStep(1); break;
    case "-": case "_": camera.zoomStep(-1); break;
    case "Home": case "h": centreOnCapital(); break;
    default: return;
  }
  if (handled) event.preventDefault();
});

pick<HTMLButtonElement>('[data-action="pause"]').addEventListener("click", (event) => {
  const btn = event.currentTarget as HTMLButtonElement;
  // The world turns on wall-clock time and other people are in it, so there is
  // nothing here to pause.
  if (game.online) return;
  if (game.running) {
    game.pause();
    btn.textContent = "Resume";
  } else {
    game.resume();
    btn.textContent = "Pause";
  }
});

pick<HTMLButtonElement>('[data-action="new"]').addEventListener("click", () => {
  if (lobby) return; // a mesh game is not this client's to restart
  start(seedFrom(String(Date.now())));
});

// --- loop --------------------------------------------------------------------

const zoomLevelEl = pick<HTMLElement>("[data-zoomlevel]");
const zoomInEl = pick<HTMLButtonElement>('[data-zoom="in"]');
const zoomOutEl = pick<HTMLButtonElement>('[data-zoom="out"]');

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
        ? `${camera.zoom}px per tile — drag, scroll, or use the arrows`
        : `${camera.zoom}px per tile — zoom past ${DOM_MIN_ZOOM}px for tile detail`,
    );
    zoomLevelEl.textContent = `${camera.zoom}`;
    zoomInEl.disabled = !camera.canZoomIn;
    zoomOutEl.disabled = !camera.canZoomOut;
    panel.setStatus(game.status());
    minimapDue = now + 200;
  }

  requestAnimationFrame(frame);
}

// --- multiplayer -------------------------------------------------------------

let lobby: Lobby | undefined;

/** The live mesh driver, when there is one. Chat goes straight to it rather
 *  than through the Driver interface: a solo game has nobody to talk to, so
 *  there is nothing for LocalGame to implement. */
let mesh: Lockstep | undefined;

const chat = new ChatPanel(chatEl, {
  send: (body) => void mesh?.say(body),
});

const panel = new LobbyPanel(lobbyEl, {
  host: () => void begin(),
  join: (code) => void begin(code),
  start: () => void lobby?.host({ bots: 1, ...SOLO_MAP }),
  leave: () => {
    lobby?.close();
    lobby = undefined;
    mesh = undefined;
    chat.close();
    panel.detach();
  },
});

async function begin(code?: string): Promise<void> {
  if (lobby) return;
  panel.connecting();

  const identity = await myIdentity();
  let opened: Lobby;
  try {
    opened = await Lobby.open(identity, code);
  } catch (error) {
    // Reaching the broker can fail outright — offline, blocked, or the service
    // is down. Swallowing it left the panel looking like the click did nothing.
    const reason = (error as Error).message;
    // A failed chunk fetch is the browser's phrasing for "you are offline", and
    // it is the first thing that breaks because PeerJS loads on demand.
    panel.detach(
      reason.includes("dynamically imported module")
        ? "could not load the networking code — check your connection."
        : reason,
    );
    return;
  }

  lobby = opened;
  panel.attach(lobby);
  lobby.onStart = (genesis, seat, transport) => {
    const driver = new Lockstep({
      genesis,
      sim: new Sim(genesis),
      roster: Roster.fromGenesis(genesis),
      transport,
      identity,
      seat,
    });
    driver.onMessage = (message) => chat.add(message);
    driver.start();

    mesh = driver;
    chat.open(seat);
    chat.note(`You are ${empireTheme(seat.empire).name}. Say hello.`);

    mount(new OnlineGame(driver, lobby!.mesh, seat));
    pick<HTMLButtonElement>('[data-action="pause"]').disabled = true;
    pick<HTMLButtonElement>('[data-action="new"]').disabled = true;
  };
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
