// Tessera — browser client.
//
// Solo play against SimBots. The sim is driven the way an online driver will
// drive it: moves in, dirty tiles out, camera and DOM strictly outside the
// simulation. Online play comes back through the Cloudflare room.

import { seedFrom, durationRules, minutes, PROTOCOL_VERSION } from "@tessera/sim";
import type { BotChoice } from "@tessera/sim";
import { displayName, fingerprint } from "@tessera/protocol";
import "@fontsource/fredoka/500.css";
import "@fontsource/fredoka/600.css";
import "@fontsource/nunito/400.css";
import "@fontsource/nunito/600.css";
import "@fontsource/nunito/700.css";
import pkg from "../package.json";
import { LocalGame } from "./game/Local";
import { boardClick } from "./game/input";
import type { Driver } from "./game/Driver";
import { myIdentity, myName, setMyName } from "./net/identity";
import { Rivals } from "./view/Rivals";
import { CreatePage, MAPS } from "./view/Create";
import type { CreateState } from "./view/Create";
import { Camera, MIN_ZOOM, MAX_ZOOM, DOM_MIN_ZOOM } from "./view/Camera";
import { MapImage } from "./view/MapImage";
import { Renderer } from "./view/Renderer";
import { Minimap } from "./view/Minimap";
import { Tabs } from "./view/Tabs";
import { Controls } from "./view/Controls";
import { Shell } from "./view/Shell";
import { Flags, injectThemeCss, setFlags } from "./view/palette";
import { OnlineGame } from "./game/Online";
import { OnlinePanel } from "./view/Online";
import { PeoplePanel } from "./view/People";
import { ChatPanel } from "./view/Chat";
import { GamesPanel } from "./view/Games";
import { Marks } from "./view/Marks";
import { offerTip } from "./view/tip";
import { GameSettingsDialog } from "./view/GameSettings";
import { KeysDialog } from "./view/Keys";
import { ReplayGame, SPEEDS } from "./game/Replay";
import type { Archive } from "./game/Replay";
import { fromBase64Url, toBase64Url, utf8, fromUtf8 } from "@tessera/protocol";
import type { SignedInvite } from "@tessera/protocol";
import { RoomLink, createGame, roomIdFrom } from "./net/room";

const pick = <T extends Element>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`missing element: ${selector}`);
  return el;
};

injectThemeCss();

const version = `v${pkg.version} · protocol ${PROTOCOL_VERSION}`;
for (const el of document.querySelectorAll("[data-version], [data-version-menu]")) {
  el.textContent = version;
}

const viewportEl = pick<HTMLDivElement>("[data-viewport]");
const tilesEl = pick<HTMLDivElement>("[data-tiles]");
const lodEl = pick<HTMLCanvasElement>("[data-lod]");
const minimapEl = pick<HTMLCanvasElement>("[data-minimap]");
const insetEl = pick<HTMLElement>("[data-inset]");
const insetMapEl = pick<HTMLCanvasElement>("[data-inset-map]");
const appEl = pick<HTMLElement>(".app");

/** Which panels start open. A desktop sidebar has room for all of them at
 *  once; a phone does not, so only the standings start open there. */
function openPanelsForWidth(): void {
  const narrow = window.matchMedia("(max-width: 900px)").matches;
  for (const panel of document.querySelectorAll<HTMLDetailsElement>(".acc")) {
    panel.open = !narrow || panel.dataset.acc === "standings";
  }
}
openPanelsForWidth();

/** The bot empires in the world, each with its own difficulty or its own tuned
 *  profile. One picker, shown under More on the create page, read by a solo
 *  game and an online one alike. */
const rivals = new Rivals(pick<HTMLElement>("[data-rivals]"));

/** How long a game is unless somebody says otherwise: 15 minutes, or what the
 *  Worker says (DEFAULT_DURATION_MINUTES). Both Play now and the create page
 *  start from it. */
let defaultLength = minutes(15);
void fetch("/api/config")
  .then((r) => (r.ok ? (r.json() as Promise<{ defaultMinutes?: number; tipUrl?: string }>) : null))
  .then((config) => {
    offerTip(config?.tipUrl ?? "");
    const wanted = config?.defaultMinutes;
    if (!wanted || wanted <= 0) return;
    defaultLength = Math.round(minutes(wanted));
    createPage.setDefaultLength(defaultLength);
  })
  .catch(() => {});

// --- settings ----------------------------------------------------------------

/** The name this browser plays under. The preview shows the cleaned string
 *  beside the fingerprint, which is what other players will see. */
const nameEl = pick<HTMLInputElement>('[data-cfg="name"]');
const nameShownEl = pick<HTMLElement>('[data-cfg="name-shown"]');
nameEl.value = myName();

async function showName(): Promise<void> {
  const identity = await myIdentity();
  nameShownEl.textContent = `Shown as ${displayName(myName(), await fingerprint(identity.key))}`;
}
void showName();

nameEl.addEventListener("change", () => {
  nameEl.value = setMyName(nameEl.value);
  void showName();
  if (nameEl.value) link?.client.setName(nameEl.value);
});

let MAP = { width: MAPS.medium.width, height: MAPS.medium.height };

let game: Driver;
let camera: Camera;
let mapImage: MapImage;
let renderer: Renderer;
let minimap: Minimap;
let inset: Minimap;
let controls: Controls;

const shell = new Shell({
  app: appEl,
  menu: pick<HTMLElement>("[data-menu]"),
  resume: pick<HTMLElement>('[data-action="resume"]'),
  menuToggle: pick<HTMLElement>("[data-menu-toggle]"),
  menuDrawer: pick<HTMLElement>("[data-menu-drawer]"),
});


// One panel at a time on a narrow screen, and the rest of the height is the
// board's. Builds itself from whatever panels are on the page, so nothing here
// has to be kept in step with the markup.
new Tabs(appEl, pick<HTMLElement>("[data-tabs]"));

// Escape shuts the game menu, the one thing layered over the board. B, L, M
// and G buy from the store while the board is showing, unless you are typing.
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") return shell.showGameMenu(false);
  if (shell.current !== "game" || event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable]")) return;
  if (controls.buyKey(event.key)) event.preventDefault();
});

/** A screen that was covered may have been resized while it was, and the board
 *  behind the menu is measured by a ResizeObserver that cannot see through it. */
shell.onScreen = (screen) => {
  resize();
  if (screen === "menu") refreshLists?.();
};

/** A fresh solo game. Play now uses the defaults (a medium map, three steady
 *  bots, the default length); the create page passes its own choices. */
function startSolo(options: { map: { width: number; height: number }; length: number; bots: BotChoice[] }): void {
  leaveRoom();
  mount(
    new LocalGame({
      seed: seedFrom(String(Date.now())),
      bots: options.bots,
      duration: durationRules(options.length),
      width: options.map.width,
      height: options.map.height,
    }),
  );
  shell.show("game");
}

const playNow = (): void =>
  startSolo({ map: MAPS.medium, length: defaultLength, bots: ["steady", "steady", "steady"] });

// --- the menu: the start page and the create page ---------------------------

const menuEl = pick<HTMLElement>("[data-menu]");
const startEl = pick<HTMLElement>("[data-start]");
const createEl = pick<HTMLElement>("[data-create-page]");

/** Set once the lists exist: the start page reloads them each time it shows. */
let refreshLists: (() => void) | undefined;

function showPage(page: "start" | "create"): void {
  if (page === "start" && menuEl.dataset.page === "create") refreshLists?.();
  menuEl.dataset.page = page;
  startEl.hidden = page !== "start";
  createEl.hidden = page !== "create";
  menuEl.scrollTop = 0;
}

const createPage = new CreatePage(createEl, rivals, pick<HTMLElement>("[data-rivals]"), {
  back: () => showPage("start"),
  submit: (state) => {
    if (state.mode === "solo") {
      startSolo({ ...createPage.solo, bots: rivals.list });
      showPage("start");
    } else {
      showPage("start");
      void createRoom(state);
    }
  },
});
pick<HTMLElement>("[data-rivals]").hidden = false;

const joinEl = pick<HTMLInputElement>("[data-join-code]");
function joinFromBox(): void {
  const text = joinEl.value.trim();
  if (!text) return joinEl.focus();
  const id = roomIdFrom(text);
  if (!id) return online.home(`"${text}" is not a game link or code.`);
  arrivedWith = decodeInvite(new URL(text, location.origin).searchParams.get("invite"));
  void enterRoom(id);
}
joinEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinFromBox();
});

startEl.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-start-action]");
  if (!button) return;
  event.preventDefault();
  switch (button.dataset.startAction) {
    case "play": return playNow();
    case "new": createPage.open("friends"); return showPage("create");
    case "solo": createPage.open("solo"); return showPage("create");
    case "join": return joinFromBox();
  }
});
showPage("start");

/** Everything downstream of here is the same for a solo game and a mesh game —
 *  the driver interface is the whole of the difference. */
function mount(driver: Driver, options: { background?: boolean } = {}): void {
  game = driver;
  // Which house each empire flies in this game, bound before anything draws.
  setFlags(new Flags(driver.sim.state.genesis.empires));
  MAP = { width: driver.sim.state.width, height: driver.sim.state.height };
  tilesEl.replaceChildren();

  camera = new Camera(MAP.width, MAP.height);
  mapImage = new MapImage(MAP.width, MAP.height);
  renderer = new Renderer(tilesEl, lodEl, camera, mapImage);
  minimap = new Minimap(minimapEl, camera, mapImage, MAP.width, MAP.height);
  inset = new Minimap(insetMapEl, camera, mapImage, MAP.width, MAP.height);
  controls = new Controls(game, {
    hud: pick<HTMLElement>("[data-you]"),
    acts: pick<HTMLElement>("[data-acts]"),
    storeHead: pick<HTMLElement>("[data-store-head]"),
    standings: pick<HTMLElement>("[data-standings]"),
    clock: pick<HTMLElement>("[data-clock]"),
    banner: pick<HTMLElement>("[data-banner]"),
    zoomhint: pick<HTMLElement>("[data-zoomhint]"),
  });
  controls.onPlaces = () => marks.showPlaces();

  // A chat column for an online game; none for a solo one.
  appEl.dataset.chat = driver.online ? "on" : "off";

  // An online game runs on wall-clock time with other people in it, so there
  // is nothing to pause. Derived from the driver rather than from its kind.
  pick<HTMLButtonElement>('[data-action="pause"]').disabled = driver.online || !driver.running;
  pick<HTMLButtonElement>('[data-action="pause"]').textContent = "Pause";
  speedEl.hidden = !(driver instanceof ReplayGame);
  if (driver instanceof ReplayGame) speedEl.textContent = `×${driver.speed}`;

  mapImage.paintAll(game.sim.state);
  centred = false;
  if (!options.background) shell.gameReady();
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

// What a tile is: on a screen with a pointer, the line under the board follows
// it; on a touch screen a long press shows the same words over the board,
// without claiming, and a tap claims as it always has.
const touchScreen = matchMedia("(pointer: coarse)").matches;
const popEl = pick<HTMLElement>("[data-tile-pop]");
const marks = new Marks(
  pick<HTMLCanvasElement>("[data-marks]"),
  touchScreen ? popEl : pick<HTMLElement>("[data-tile-info]"),
);
marks.idle = touchScreen ? "" : "Point at a tile to see what's on it.";
marks.press = touchScreen ? "tap" : "click";

/** A press held this long without moving shows the tile instead of claiming. */
const LONG_PRESS_MS = 450;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let longPressed = false;
let popHide: ReturnType<typeof setTimeout> | undefined;

viewportEl.addEventListener("pointerdown", (event) => {
  if (onControls(event)) return;
  dragging = true;
  dragMoved = 0;
  lastX = event.clientX;
  lastY = event.clientY;
  viewportEl.setPointerCapture(event.pointerId);
  longPressed = false;
  if (event.pointerType === "touch") {
    clearTimeout(pressTimer);
    clearTimeout(popHide);
    marks.pointAt(null);
    const { clientX, clientY } = event;
    pressTimer = setTimeout(() => {
      if (!dragging || dragMoved > 8) return;
      const tile = tileAt(clientX, clientY);
      if (!tile) return;
      longPressed = true;
      const board = popEl.parentElement!.getBoundingClientRect();
      const x = Math.min(Math.max(clientX - board.left, 90), board.width - 90);
      popEl.style.left = `${x}px`;
      popEl.style.top = `${Math.max(clientY - board.top, 60)}px`;
      marks.pointAt(tile);
      navigator.vibrate?.(10);
    }, LONG_PRESS_MS);
  }
});
// A long press is not a request for the browser's own menu.
viewportEl.addEventListener("contextmenu", (event) => event.preventDefault());

/** The tile under the pointer, for the outline and the line describing it
 *  under the board. Touch has no hover: see the long press above. */
function pointAt(event: PointerEvent): void {
  if (event.pointerType === "touch") return;
  if (onControls(event)) return marks.pointAt(null);
  marks.pointAt(tileOf(event));
}
function tileAt(clientX: number, clientY: number): [number, number] | null {
  const rect = viewportEl.getBoundingClientRect();
  const [x, y] = camera.tileAt(clientX - rect.left, clientY - rect.top);
  return x < 0 || y < 0 || x >= MAP.width || y >= MAP.height ? null : [x, y];
}
const tileOf = (event: PointerEvent): [number, number] | null => tileAt(event.clientX, event.clientY);
viewportEl.addEventListener("pointerleave", (event) => {
  if (event.pointerType !== "touch") marks.pointAt(null);
});

viewportEl.addEventListener("pointermove", (event) => {
  if (!dragging) return pointAt(event);
  const dx = event.clientX - lastX;
  const dy = event.clientY - lastY;
  lastX = event.clientX;
  lastY = event.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  if (longPressed) return;
  camera.panByPixels(dx, dy);
});

viewportEl.addEventListener("pointerup", (event) => {
  if (onControls(event)) return;
  if (!dragging) return;
  dragging = false;
  viewportEl.releasePointerCapture(event.pointerId);
  // A drag is a pan, not a click.
  clearTimeout(pressTimer);
  if (longPressed) {
    // Shown, not claimed. The words stay a moment after the finger lifts.
    longPressed = false;
    popHide = setTimeout(() => marks.pointAt(null), 1800);
    return;
  }
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

function centreOnCapital(id = game.empire): void {
  // An observer has no capital to go home to; leave the camera where it is.
  const empire = game.sim.state.empires[id - 1];
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

const speedEl = pick<HTMLButtonElement>('[data-action="speed"]');
speedEl.addEventListener("click", () => {
  if (!(game instanceof ReplayGame)) return;
  const next = SPEEDS[(SPEEDS.indexOf(game.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
  game.setSpeed(next);
  speedEl.textContent = `×${next}`;
});

// The wordmark and the menu's Start page both go to the start page. An online
// game carries on without you and waits under Your games with a Resume button,
// so the room is left; a solo game lives only in this tab, so it is kept, with
// Back to the game on the start page. A new tab or window opens the page itself.
for (const home of document.querySelectorAll<HTMLAnchorElement>("[data-home]")) {
  home.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    if (link) {
      leaveRoom();
      shell.left();
    } else {
      shell.show("menu");
    }
  });
}
// Settings, over the board: the game keeps running behind the dialog.
const settingsDialog = new GameSettingsDialog(
  pick<HTMLDialogElement>("[data-settings-dialog]"),
  pick<HTMLElement>("[data-settings-body]"),
  {
    rename: (name) => {
      nameEl.value = setMyName(name);
      void showName();
      if (nameEl.value) link?.client.setName(nameEl.value);
      void openSettings();
    },
    setPublic: (value) => link?.client.setPublic(value),
    setChat: (mode) => link?.client.setChatMode(mode),
  },
);

async function settingsContext() {
  const identity = await myIdentity();
  const client = link?.client;
  return {
    state: game.sim.state,
    name: myName(),
    shownAs: `Shown as ${displayName(myName(), await fingerprint(identity.key))}`,
    ...(client && link
      ? {
          online: {
            link: `${location.origin}/g/${link.roomId}`,
            settings: client.settings,
            mine: client.settings?.creator === identity.key,
          },
        }
      : {}),
  };
}

async function openSettings(): Promise<void> {
  const context = await settingsContext();
  if (settingsDialog.open) settingsDialog.update(context);
  else settingsDialog.show(context);
}
pick<HTMLButtonElement>('[data-action="settings"]').addEventListener("click", () => void openSettings());

// --- online ------------------------------------------------------------------

/** The room this tab is in, if any. */
let link: RoomLink | undefined;
/** An invite this tab arrived with, redeemed once the game is on screen. */
let arrivedWith: SignedInvite | undefined;

const people = new PeoplePanel(pick<HTMLElement>("[data-people]"), pick<HTMLElement>("[data-people-panel]"), {
  approve: (key) => link?.client.approve(key),
  decline: (key) => link?.client.decline(key),
  withdraw: () => link?.client.withdraw(),
  invite: async () => {
    const current = link;
    const signed = await current?.client.invite();
    if (!current || !signed) return undefined;
    return `${location.origin}/g/${current.roomId}?invite=${encodeInvite(signed)}`;
  },
});

const encodeInvite = (signed: SignedInvite): string => toBase64Url(utf8(JSON.stringify(signed)));
function decodeInvite(text: string | null): SignedInvite | undefined {
  const bytes = text ? fromBase64Url(text) : null;
  if (!bytes) return undefined;
  try {
    return JSON.parse(fromUtf8(bytes)) as SignedInvite;
  } catch {
    return undefined;
  }
}

const chat = new ChatPanel(pick<HTMLElement>("[data-chat]"), pick<HTMLElement>("[data-chat-section]"), (text, channel) =>
  link?.client.say(text, channel),
);

// The small map on the board. Shut or open is remembered on this device; the
// layout decides whether there is room for it at all.
const INSET_KEY = "tessera.inset";
function setInset(open: boolean): void {
  insetEl.dataset.open = open ? "on" : "off";
  const toggle = pick<HTMLButtonElement>("[data-inset-toggle]");
  toggle.innerHTML = open ? "&times;" : "&#9634;";
  toggle.title = toggle.ariaLabel = open ? "Hide the small map" : "Show the small map";
  try {
    localStorage.setItem(INSET_KEY, open ? "on" : "off");
  } catch {
    // Remembering it is a convenience.
  }
}
setInset((() => {
  try {
    return localStorage.getItem(INSET_KEY) !== "off";
  } catch {
    return true;
  }
})());
pick<HTMLElement>("[data-inset-toggle]").addEventListener("click", () =>
  setInset(insetEl.dataset.open !== "on"),
);

/** The buttons on the standings list: show an empire's capital on the board,
 *  and the two doors into a running game, taking an empire nobody holds or
 *  asking one that somebody does. */
pick<HTMLElement>("[data-standings]").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-find], [data-claim], [data-ask]");
  if (!button) return;
  // The buttons sit in an empire's summary line; pressing one is not a toggle.
  event.preventDefault();
  if (button.dataset.find) return centreOnCapital(Number(button.dataset.find));
  if (!link) return;
  if (button.dataset.claim) link.client.claim(Number(button.dataset.claim));
  else link.client.ask(Number(button.dataset.ask));
});
/** What to do once we are in the lobby of a game we just created. */
let afterCreate: { start: boolean } | undefined;

const online = new OnlinePanel(
  {
    root: pick<HTMLElement>("[data-online-card]"),
    body: pick<HTMLElement>("[data-online-body]"),
  },
  {
    create: () => {
      createPage.open("friends");
      showPage("create");
    },
    join: (input) => {
      const id = roomIdFrom(input);
      if (!id) return online.home(`"${input.trim()}" is not a game link or code.`);
      void enterRoom(id);
    },
    pick: (empire) => link?.client.pickEmpire(empire),
    start: () => link?.client.start(),
    leave: () => {
      leaveRoom();
      shell.left();
    },
  },
);

const games = new GamesPanel(pick<HTMLElement>("[data-games]"), {
  open: (id) => void enterRoom(id),
  replay: (id) => void openReplay(id),
  me: async () => (await myIdentity()).key,
});
games.refresh();
refreshLists = () => games.refresh();

async function createRoom(form: CreateState): Promise<void> {
  const identity = await myIdentity();
  try {
    const id = await createGame({
      creator: identity.key,
      empires: form.empires,
      seatsPerEmpire: form.seats,
      bots: rivals.list,
      map: form.map,
      hours: form.length / 12 / 3600,
      public: form.public,
      ...(form.mode === "friends" && form.chat ? { chat: form.chat } : {}),
      ...(form.start === "scheduled" && form.startAt ? { startAt: form.startAt } : {}),
    });
    afterCreate = { start: form.start === "now" };
    await enterRoom(id);
  } catch (error) {
    online.home(`Could not create the game: ${(error as Error).message}`);
  }
}

/** Watch a finished game from its archive. */
async function openReplay(roomId: string): Promise<void> {
  leaveRoom();
  online.connecting(roomId, "Fetching the replay…");
  try {
    const response = await fetch(`/api/games/${roomId}/archive`);
    if (!response.ok) throw new Error(response.status === 404 ? "it has no archive yet" : `the server said ${response.status}`);
    const archive = (await response.json()) as Archive;
    if (location.pathname !== `/g/${roomId}`) history.pushState(null, "", `/g/${roomId}`);
    mount(new ReplayGame(archive));
    online.home();
    shell.show("game");
  } catch (error) {
    online.home(`Could not open that replay: ${(error as Error).message}`);
  }
}

/** Open a game's room. Its lobby shows on the menu; once it is running, the
 *  board takes over. A game whose room has been archived away opens as its
 *  replay. */
async function enterRoom(roomId: string): Promise<void> {
  const known = await fetch(`/api/games/${roomId}`)
    .then((r) => (r.ok ? (r.json() as Promise<{ archived?: boolean; phase?: string }>) : null))
    .catch(() => undefined);
  if (known === null) return online.home(`There is no game "${roomId}".`);
  if (known?.archived && known.phase === "ended") return openReplay(roomId);
  leaveRoom();
  if (location.pathname !== `/g/${roomId}`) history.pushState(null, "", `/g/${roomId}`);
  online.connecting(roomId);
  // The menu, without "Back to the game": the game behind it is the one being
  // left. It comes back when this room's game is on the board.
  shell.left();
  showPage("start");

  const identity = await myIdentity();
  const opened = new RoomLink({
    roomId,
    identity,
    name: myName(),
    onState: (state) => {
      if (link !== opened) return;
      if (state === "retrying" && !opened.client.sim) online.connecting(roomId, "Reconnecting…");
    },
  });
  link = opened;
  const client = opened.client;

  client.onError = (message) => {
    if (link !== opened) return;
    // Before the game, a refusal is the whole story; during it, it is about
    // something just said or done, and the chat is where it is read.
    if (!client.sim) online.connecting(roomId, message);
    else chat.notice(message);
  };
  client.onLobby = (lobby) => {
    if (link !== opened) return;
    online.lobby(roomId, lobby, identity.key);
    if (afterCreate && lobby.creator === identity.key) {
      const me = lobby.players.find((p) => p.key === identity.key);
      if (me && me.empire === null) client.pickEmpire(0);
      else if (me && afterCreate.start) {
        afterCreate = undefined;
        client.start();
      } else afterCreate = undefined;
    }
  };
  // The first full picture of a running game — at the start, or on arriving
  // at one already going — is when the board takes over.
  client.onReset = () => {
    if (link !== opened || !client.sim) return;
    mount(new OnlineGame(client));
    online.playing(roomId);
    shell.show("game");
    chat.open(client.chat, identity.key, !!client.you?.seat);
    showPeople();
    if (arrivedWith && !client.you?.seat) client.redeem(arrivedWith);
    arrivedWith = undefined;
  };
  const showPeople = (): void => {
    if (link !== opened) return;
    people.set(client.people, identity.key, client.you?.seat?.empire ?? 0);
    controls?.setPeople(client.people.people);
  };
  client.onPeople = showPeople;
  client.onSettings = () => {
    if (link !== opened) return;
    chat.mode(client.settings?.chat ?? "open");
    if (settingsDialog.open) void settingsContext().then((c) => settingsDialog.update(c));
  };
  client.onChat = (lines) => {
    if (link === opened) chat.add(lines, identity.key);
  };
  client.onSeated = () => {
    showPeople();
    chat.seated(true);
    // A spectator who has just been given a seat wants to see their empire.
    if (link === opened) centreOnCapital();
  };
  opened.connect();
}

/** Put down the room this tab is in, if any. */
function leaveRoom(): void {
  if (!link) return;
  link.close();
  link = undefined;
  afterCreate = undefined;
  people.set(null);
  controls?.setPeople([]);
  chat.close();
  if (location.pathname.startsWith("/g/")) history.pushState(null, "", "/");
  online.home();
}

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
  marks.render(game.sim.state, game, camera);

  // The minimap does not need 60fps.
  if (now >= minimapDue) {
    // Drawn only where it is on screen: each is hidden on some layouts.
    if (minimapEl.offsetParent) minimap.render(game.sim.state);
    if (insetMapEl.offsetParent) inset.render(game.sim.state);
    controls.render(game.sim.state);
    controls.setZoomHint(
      camera.zoom >= DOM_MIN_ZOOM
        ? `${camera.zoom}px per tile`
        : `${camera.zoom}px per tile — blocks below ${DOM_MIN_ZOOM}px`,
    );
    zoomLevelEl.textContent = `${camera.zoom}`;
    zoomInEl.disabled = !camera.canZoomIn;
    zoomOutEl.disabled = !camera.canZoomOut;
    minimapDue = now + 200;
  }

  requestAnimationFrame(frame);
}

// Something for the board to draw before any game is chosen. Not a game you
// can go back to, so the menu does not offer one.
mount(
  new LocalGame({
    seed: seedFrom("tessera"),
    bots: ["steady", "steady", "steady"],
    duration: durationRules(defaultLength),
    width: MAPS.medium.width,
    height: MAPS.medium.height,
  }),
  { background: true },
);
requestAnimationFrame(frame);

// A game link opens that game.
const linked = location.pathname.startsWith("/g/") ? roomIdFrom(location.pathname) : null;
if (linked) {
  arrivedWith = decodeInvite(new URLSearchParams(location.search).get("invite"));
  if (location.search) history.replaceState(null, "", location.pathname);
  void enterRoom(linked);
}

Object.assign(window as unknown as Record<string, unknown>, {
  tessera: {
    get game() { return game; },
    get camera() { return camera; },
    get client() { return link?.client; },
    MIN_ZOOM,
    MAX_ZOOM,
  },
});

// --- your player ---------------------------------------------------------------

const keys = new KeysDialog(pick<HTMLDialogElement>("[data-keys]"), pick<HTMLElement>("[data-keys-body]"));
// The gear on the start page, and a button in a game's Settings.
document.addEventListener("click", (event) => {
  if (!(event.target as HTMLElement).closest("[data-account-open]")) return;
  pick<HTMLDialogElement>("[data-settings-dialog]").close();
  keys.home();
});
document.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-keys-action]");
  switch (button?.dataset.keysAction) {
    case "backup": return void keys.backup();
    case "move": return keys.move();
    case "restore": return void keys.restore();
    case "remove": return void keys.remove();
  }
});
// A backup link: offer to use it, and take it out of the address bar, where
// it would otherwise sit in the history and be shared with the page.
{
  const restore = /(?:^|[#&])restore=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1];
  if (restore) {
    history.replaceState(null, "", location.pathname + location.search);
    void keys.restore(restore);
  }
}
