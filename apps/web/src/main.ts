// Tessera — browser client.
//
// Local play against SimBots for now. The sim is driven exactly as the Phase C
// lockstep driver will drive it: moves in, dirty tiles out, camera and DOM
// strictly outside the simulation.

import { seedFrom, PROTOCOL_VERSION, Sim } from "@tessera/sim";
import { Roster } from "@tessera/protocol";
import { Archive, Lobby, Lockstep } from "@tessera/net";
import pkg from "../package.json";
import { LocalGame } from "./game/Local";
import { boardClick } from "./game/input";
import { OnlineGame } from "./game/Online";
import type { Driver } from "./game/Driver";
import { myIdentity } from "./net/identity";
import { LobbyPanel } from "./view/LobbyPanel";
import { Rivals } from "./view/Rivals";
import type { RosterView } from "./view/LobbyPanel";
import { ChatPanel } from "./view/Chat";
import { Camera, MIN_ZOOM, MAX_ZOOM, DOM_MIN_ZOOM } from "./view/Camera";
import { MapImage } from "./view/MapImage";
import { Renderer } from "./view/Renderer";
import { Minimap } from "./view/Minimap";
import { Tabs } from "./view/Tabs";
import { Controls } from "./view/Controls";
import { Shell } from "./view/Shell";
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
const version = `v${pkg.version} · protocol ${PROTOCOL_VERSION}`;
for (const el of document.querySelectorAll("[data-version], [data-version-menu]")) {
  el.textContent = version;
}

const viewportEl = pick<HTMLDivElement>("[data-viewport]");
const tilesEl = pick<HTMLDivElement>("[data-tiles]");
const lodEl = pick<HTMLCanvasElement>("[data-lod]");
const minimapEl = pick<HTMLCanvasElement>("[data-minimap]");
const lobbyEl = pick<HTMLDivElement>("[data-lobby]");
const chatEl = pick<HTMLDivElement>("[data-chat]");
const chatSideEl = pick<HTMLElement>("[data-chat-section]");
const appEl = pick<HTMLElement>(".app");

/** Which panels start open. A desktop sidebar has room for all of them at
 *  once; a phone does not, and a column of open accordions is exactly the
 *  wasted space they exist to avoid — so only the standings, the one worth a
 *  glance between clicks, starts open there. Set once, then left alone: after
 *  this the state is the reader's. */
function openPanelsForWidth(): void {
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  for (const panel of document.querySelectorAll<HTMLDetailsElement>(".acc")) {
    panel.open = !narrow || panel.dataset.acc === "standings";
  }
}
openPanelsForWidth();

/** Map sizes offered on the setup screen. A mesh game uses whatever its genesis
 *  says, so these are a starting point rather than an assumption the view makes
 *  anywhere else. */
const MAP_SIZES: Record<string, { width: number; height: number }> = {
  small: { width: 96, height: 72 },
  medium: { width: 160, height: 112 },
  large: { width: 256, height: 176 },
};

/** The map the setup screen is asking for. Read at the moment a game starts
 *  rather than cached, so changing the dropdown and pressing start agree. */
const mapSize = () =>
  MAP_SIZES[pick<HTMLSelectElement>('[data-cfg="size"]').value] ?? MAP_SIZES.medium!;

/** The rival empires the solo card is offering, each with its own difficulty.
 *  It renders itself, so nothing here has to know how many there are. */
const rivals = new Rivals(pick<HTMLElement>('[data-cfg="rivals"]'));

const soloSetup = () => ({ bots: rivals.list, ...mapSize() });

let MAP = { ...MAP_SIZES.medium! };

let game: Driver;
let camera: Camera;
let mapImage: MapImage;
let renderer: Renderer;
let minimap: Minimap;
let controls: Controls;

const shell = new Shell({
  app: appEl,
  menu: pick<HTMLElement>("[data-menu]"),
  resume: pick<HTMLElement>('[data-action="resume"]'),
  itemsToggle: pick<HTMLElement>("[data-items-toggle]"),
  itemsDrawer: pick<HTMLElement>("[data-items-drawer]"),
});

// One panel at a time on a narrow screen, and the rest of the height is the
// board's. Builds itself from whatever panels are on the page, so nothing here
// has to be kept in step with the markup.
new Tabs(appEl, pick<HTMLElement>("[data-tabs]"));

// Escape shuts the shop; there is nothing else layered over the board.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") shell.showItems(false);
});

/** A screen that was covered may have been resized while it was, and the board
 *  behind the menu is measured by a ResizeObserver that cannot see through it. */
shell.onScreen = () => resize();

function start(seed: number): void {
  mount(new LocalGame({ seed, ...soloSetup() }));
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
    hud: pick<HTMLElement>("[data-you]"),
    acts: pick<HTMLElement>("[data-acts]"),
    standings: pick<HTMLElement>("[data-standings]"),
    roster: pick<HTMLElement>("[data-roster]"),
    rosterPanel: pick<HTMLElement>("[data-roster-panel]"),
    clock: pick<HTMLElement>("[data-clock]"),
    banner: pick<HTMLElement>("[data-banner]"),
    zoomhint: pick<HTMLElement>("[data-zoomhint]"),
  });

  // Nobody to talk to in a solo game, so the right sidebar goes entirely and
  // the grid drops its column rather than reserving an empty one.
  chatSideEl.hidden = !driver.online;
  appEl.dataset.chat = driver.online ? "on" : "off";

  // The world turns on wall-clock time and other people are in it, so there is
  // nothing in a mesh game to pause. Derived from the driver rather than
  // switched off at the mesh call site, which left it stuck off for the next
  // solo game you started.
  pick<HTMLButtonElement>('[data-action="pause"]').disabled = driver.online;
  pick<HTMLButtonElement>('[data-action="pause"]').textContent = "Pause";

  mapImage.paintAll(game.sim.state);
  centred = false;
  shell.gameReady();
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
  // The camera can sit a little past the map's edge, so a click can land on
  // nothing at all. That is not a move; it is how you reach the corner tiles
  // without the controls on top of them.
  if (x < 0 || y < 0 || x >= MAP.width || y >= MAP.height) return;

  boardClick(game, x, y);
  // Clicking near the edge says where you are going. Following it there saves
  // a separate pan gesture, which on a phone is several.
  camera.revealAround(x, y);
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
  // An observer has no capital to go home to; leave the camera where it is.
  const empire = game.sim.state.empires[game.empire - 1];
  if (!empire) return;
  camera.centreOn(empire.capital % MAP.width, Math.floor(empire.capital / MAP.width));
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
  // The board is not what the arrow keys are for while the setup screen is up.
  if (shell.current !== "game") return;
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

/** Put down a mesh session if this client holds one. Leaving has to be real:
 *  the peers still playing would otherwise wait on a seat that had wandered
 *  off. A solo game has nothing to close. */
function leaveMesh(): void {
  if (!lobby) return;
  lobby.close();
  lobby = undefined;
  mesh = undefined;
  archive = undefined;
  archiveBtn.hidden = true;
  chat.close();
  panel.detach();
}

/** Hand the player their own copy of the game.
 *
 *  This is the other half of a checkable result. `verifyArchive` rebuilds the
 *  roster from the genesis record and checks every signature in the file
 *  against it, so what comes down here is not a score anybody is asked to
 *  believe — it is the inputs, and the hash they produce, for anyone to run
 *  themselves. A tab holds the log anyway; all that was missing was a way to
 *  get it out. */
const archiveBtn = pick<HTMLButtonElement>('[data-action="archive"]');
archiveBtn.addEventListener("click", () => {
  if (!archive) return;
  const game = archive.toJSON();
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(game)], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = `tessera-${(game.genesis.gameId ?? "game").slice(0, 12)}-${game.steps}.json`;
  link.click();
  // Revoked on the next turn rather than immediately: the click is synchronous
  // but the fetch the browser starts for it is not.
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

pick<HTMLButtonElement>('[data-action="solo"]').addEventListener("click", () => {
  leaveMesh();
  start(seedFrom(String(Date.now())));
  shell.show("game");
});

// "Menu" said nothing about what pressing it did. This is the way out of a
// game: it puts down the mesh session, if there is one, and goes back to the
// lobby — so it says so, and it actually leaves rather than pretending to.
pick<HTMLButtonElement>('[data-action="leave"]').addEventListener("click", () => {
  leaveMesh();
  shell.left();
});

pick<HTMLButtonElement>('[data-action="resume"]').addEventListener("click", () => {
  shell.show("game");
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
        ? `${camera.zoom}px per tile`
        : `${camera.zoom}px per tile — blocks below ${DOM_MIN_ZOOM}px`,
    );
    zoomLevelEl.textContent = `${camera.zoom}`;
    zoomInEl.disabled = !camera.canZoomIn;
    zoomOutEl.disabled = !camera.canZoomOut;
    panel.setStatus(game.status());
    panel.setRoster(mesh ? rosterView(mesh) : null);
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
/** The game this tab has been writing down, for as long as it has been in it.
 *
 *  A tab is not a durable archive and is not pretending to be one — that is
 *  what the observer is for. What it is, is the copy the person who actually
 *  played holds: signed, replayable, and theirs to keep or to hand to anybody
 *  who would like to check the result rather than take their word for it. */
let archive: Archive | undefined;

const chat = new ChatPanel(chatEl, {
  send: (body, channel) => void mesh?.say(body, channel),
});

const panel = new LobbyPanel(lobbyEl, {
  host: () => void begin(),
  join: (code) => void begin(code),
  start: (plan) => void lobby?.host({ ...plan, ...mapSize() }),
  leave: () => {
    lobby?.close();
    lobby = undefined;
    mesh = undefined;
    chat.close();
    panel.detach();
  },
  invite: (key) => void mesh?.amend(key),
  endorse: (empire, key) => void mesh?.endorse(empire, key),
});

/** Chat needs a seat: which empire the team channel is sealed to, and whether
 *  there is anyone on it to seal to. */
function openChat(seat: { empire: number; member: number }): void {
  const empires = mesh?.sim.state.empires ?? [];
  chat.open(seat, (empires[seat.empire - 1]?.members.length ?? 1) - 1);
  chat.note(`You are ${empireTheme(seat.empire).name}. Say hello.`);
}

/** Who is here without a seat, and what our empire is being asked to sign.
 *
 *  Recomputed rather than remembered: the roster changes underneath this — a
 *  vote carries, somebody arrives — and a cached answer would be wrong in
 *  exactly the moments it matters. The panel drops it when nothing changed. */
function rosterView(driver: Lockstep): RosterView {
  const here = lobby?.players() ?? [];
  const ours = driver.seat?.empire;
  return {
    watching: !driver.seat,
    waiting: here.filter((who) => !who.you && !driver.roster.has(who.key)),
    asks: driver
      .invitations()
      .filter((record) => record.amendment.empire === ours)
      .map((record) => ({
        key: record.amendment.key,
        empire: record.amendment.empire,
        label: here.find((who) => who.key === record.amendment.key)?.label ?? "someone",
        endorsed: record.signatures.length,
        needed: driver.roster.quorum(record.amendment.empire),
      })),
  };
}

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

    archive = new Archive(genesis, driver);
    archive.attach(driver);
    archiveBtn.hidden = false;

    driver.onMessage = (message, text) => chat.add(message, text);
    // Being voted a seat mid-game is the moment an observer becomes a player.
    // Nothing about the driver changes — it was already verifying every move —
    // so all that is left is to open the parts of the UI that need a seat.
    driver.onSeated = (given, key) => {
      if (key !== identity.key) return;
      openChat(given);
      panel.setStatus(`You have been seated as ${empireTheme(given.empire).name}.`);
    };
    driver.start();

    mesh = driver;
    if (seat) openChat(seat);

    mount(new OnlineGame(driver, lobby!.mesh));
    shell.show("game");
  };
}

start(seedFrom("tessera"));
requestAnimationFrame(frame);

Object.assign(window as unknown as Record<string, unknown>, {
  tessera: {
    get game() { return game; },
    get camera() { return camera; },
    get mesh() { return mesh; },
    get lobby() { return lobby; },
    MIN_ZOOM,
    MAX_ZOOM,
  },
});
