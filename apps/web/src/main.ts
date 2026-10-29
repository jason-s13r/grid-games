// Tessera — browser client.
//
// Solo play against SimBots. The sim is driven the way an online driver will
// drive it: moves in, dirty tiles out, camera and DOM strictly outside the
// simulation. Online play comes back through the Cloudflare room.

import { seedFrom, durationRules, hours, minutes, PROTOCOL_VERSION } from "@tessera/sim";
import { displayName, fingerprint } from "@tessera/protocol";
import pkg from "../package.json";
import { LocalGame } from "./game/Local";
import { boardClick } from "./game/input";
import type { Driver } from "./game/Driver";
import { myIdentity, myName, setMyName } from "./net/identity";
import { Setup } from "./view/Setup";
import type { SetupSummary } from "./view/Setup";
import { Rivals } from "./view/Rivals";
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

/** Map sizes offered on the setup screen. A mesh game uses whatever its genesis
 *  says, so these are a starting point rather than an assumption the view makes
 *  anywhere else.
 *
 *  Read for a solo game and a hosted one alike. They are the same world with
 *  different seats in it, so the form asks once and whichever start button you
 *  pressed takes the answer — which is also the only way the two can be
 *  guaranteed not to disagree. */
const MAP_SIZES: Record<string, { width: number; height: number }> = {
  small: { width: 96, height: 72 },
  medium: { width: 160, height: 112 },
  large: { width: 256, height: 176 },
};

/** The map the setup screen is asking for. Read at the moment a game starts
 *  rather than cached, so changing the dropdown and pressing start agree. */
const mapSize = () =>
  MAP_SIZES[pick<HTMLSelectElement>('[data-cfg="size"]').value] ?? MAP_SIZES.medium!;

/** Lengths the setup screen suggests. A list beside the picker rather than a
 *  type in the sim: the old `type Duration = "3h" | "1d" | ...` is what a host
 *  had to extend to add 45 minutes, and what lands in the genesis is only ever
 *  three numbers anyway.
 *
 *  No open-ended entry, and that is the one thing the two kinds of game could
 *  not be given identically. Every hosted game from v4 on has an end date, because
 *  that is what makes a version's sunset derivable rather than a judgement
 *  call — a running game cannot be upgraded, so a game with no end is a game
 *  nobody can promise to still play. A solo game could have been left
 *  open-ended, but a list with an entry that quietly means "multiplayer only"
 *  is the sort of thing the combined form exists to get rid of. `endStep: 0`
 *  stays legal in the sim forever, for every v3 record and for anybody
 *  composing a genesis by hand. */
const COMMON_DURATIONS: ReadonlyArray<{ label: string; steps: number }> = [
  { label: "15 minutes", steps: minutes(15) },
  { label: "30 minutes", steps: minutes(30) },
  { label: "1 hour", steps: hours(1) },
  { label: "3 hours", steps: hours(3) },
  { label: "6 hours", steps: hours(6) },
  { label: "1 day", steps: hours(24) },
  { label: "3 days", steps: hours(72) },
  { label: "5 days", steps: hours(120) },
  { label: "10 days", steps: hours(240) },
];

const lengthEl = pick<HTMLSelectElement>('[data-cfg="length"]');
lengthEl.innerHTML = COMMON_DURATIONS.map(
  (d, i) => `<option value="${d.steps}"${i === 4 ? " selected" : ""}>${d.label}</option>`,
).join("");

const onlineLengthEl = pick<HTMLSelectElement>('[data-online="length"]');
onlineLengthEl.innerHTML = COMMON_DURATIONS.map(
  (d) => `<option value="${d.steps}"${d.steps === hours(240) ? " selected" : ""}>${d.label}</option>`,
).join("");

/** The duration the setup screen is asking for. Read at the moment a game
 *  starts rather than cached, the same way the map size is, so changing the
 *  dropdown and pressing start agree. */
const duration = () => durationRules(Number(lengthEl.value));

/** The bot empires in the world, each with its own difficulty or its own tuned
 *  profile. It renders itself, so nothing here has to know how many there are —
 *  and there is one of it, read by a solo game and a hosted one alike. */
const rivals = new Rivals(pick<HTMLElement>('[data-cfg="rivals"]'));
/** The online form's bots: its own picker, so the two forms do not share one. */
const onlineRivals = new Rivals(pick<HTMLElement>('[data-online="rivals"]'));

const soloSetup = () => ({ bots: rivals.list, duration: duration(), ...mapSize() });

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

/** A fresh solo game from whatever the form currently says. */
function startSolo(): void {
  leaveRoom();
  start(seedFrom(String(Date.now())));
  shell.show("game");
}

/** What the game as configured comes to, and why it cannot be started yet. */
function summarise(): SetupSummary {
  const bots = rivals.count;
  if (bots < 1) {
    return {
      note: "A solo game needs somebody to play against — add a bot empire.",
      problem: true,
      ready: false,
    };
  }
  const who = `you and ${bots} bot ${bots === 1 ? "empire" : "empires"}`;
  return { note: `${bots + 1} empires will be in the world: ${who}.`, problem: false, ready: true };
}

const setup = new Setup(
  {
    root: pick<HTMLElement>("[data-setup]"),
    head: pick<HTMLElement>("[data-setup-head]"),
    form: pick<HTMLElement>("[data-setup-form]"),
    foot: pick<HTMLElement>("[data-setup-foot]"),
  },
  { start: () => startSolo(), summary: () => summarise() },
);
rivals.onChange = () => setup.refresh();

/** Everything downstream of here is the same for a solo game and a mesh game —
 *  the driver interface is the whole of the difference. */
function mount(driver: Driver): void {
  game = driver;
  // Which house each empire flies in this game, bound before anything draws.
  setFlags(new Flags(driver.sim.state.genesis.empires));
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

const speedEl = pick<HTMLButtonElement>('[data-action="speed"]');
speedEl.addEventListener("click", () => {
  if (!(game instanceof ReplayGame)) return;
  const next = SPEEDS[(SPEEDS.indexOf(game.speed as (typeof SPEEDS)[number]) + 1) % SPEEDS.length]!;
  game.setSpeed(next);
  speedEl.textContent = `×${next}`;
});

pick<HTMLButtonElement>('[data-action="leave"]').addEventListener("click", () => {
  if (link) leaveRoom();
  shell.left();
});

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

/** The two doors into a running game, on the standings list: take an empire
 *  nobody holds, or ask one that somebody does. */
pick<HTMLElement>("[data-standings]").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-claim], [data-ask]");
  if (!button || !link) return;
  if (button.dataset.claim) link.client.claim(Number(button.dataset.claim));
  else link.client.ask(Number(button.dataset.ask));
});
/** What to do once we are in the lobby of a game we just created. */
let afterCreate: { start: boolean } | undefined;

const online = new OnlinePanel(
  {
    root: pick<HTMLElement>("[data-online-card]"),
    form: pick<HTMLElement>("[data-online-form]"),
    body: pick<HTMLElement>("[data-online-body]"),
  },
  {
    create: () => void createRoom(),
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
games.show("open");

async function createRoom(): Promise<void> {
  const form = online.read();
  if (form.start === "scheduled" && !form.startAt) return online.home("Pick a start time.");
  const identity = await myIdentity();
  try {
    const id = await createGame({
      creator: identity.key,
      empires: form.empires,
      seatsPerEmpire: form.seatsPerEmpire,
      bots: onlineRivals.list,
      map: form.map,
      hours: form.hours,
      public: form.public,
      ...(form.startAt ? { startAt: form.startAt } : {}),
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
  shell.show("menu");

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
    if (link === opened && !client.sim) online.connecting(roomId, message);
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
    if (link === opened) people.set(client.people, identity.key, client.you?.seat?.empire ?? 0);
  };
  client.onPeople = showPeople;
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
    minimapDue = now + 200;
  }

  requestAnimationFrame(frame);
}

start(seedFrom("tessera"));
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
