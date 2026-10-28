// End to end against a running Worker: two players create, join, start and play
// a game through its Durable Object, and one of them drops and comes back.
//
//   pnpm --filter @tessera/worker smoke [http://127.0.0.1:8787]
//
// Needs `pnpm dev` (or `wrangler dev`) running, and the packages built.

import { Identity } from "@tessera/protocol";
import { RoomClient } from "@tessera/room";
import { MOVE } from "@tessera/sim";

const base = process.argv[2] ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

function connect(identity, roomId, name, existing) {
  const socket = new WebSocket(`${wsBase}/game/${roomId}/ws`);
  const send = (text) => socket.readyState === 1 && socket.send(text);
  const client = existing ?? new RoomClient({ identity, roomId, name, send });
  if (existing) existing.reconnected(send);
  client.onError = (message) => console.log(`  ${name} error: ${message}`);
  socket.addEventListener("message", (event) => void client.receive(event.data));
  return { client, socket };
}

async function waitFor(what, test, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    await sleep(50);
  }
  fail(`timed out waiting for ${what}`);
}

const [alice, bob] = await Promise.all([Identity.generate(), Identity.generate()]);

const created = await fetch(`${base}/api/games`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ creator: alice.key, bots: ["easy"], hours: 1, map: "small" }),
});
if (created.status !== 201) fail(`create returned ${created.status}: ${await created.text()}`);
const { id } = await created.json();
console.log(`created ${id}`);

const a = connect(alice, id, "alice");
let b = connect(bob, id, "bob");
await waitFor("both in the lobby", () => a.client.lobby?.players.length === 2);
console.log("lobby has both players");

a.client.pickEmpire(0);
b.client.pickEmpire(1);
await waitFor("both picks", () => a.client.lobby?.players.every((p) => p.empire !== null));
a.client.start();
await waitFor("the start", () => a.client.sim && b.client.sim);
console.log(`started: game ${a.client.genesis.gameId.slice(0, 12)}…, seats`, a.client.you.seat, b.client.you.seat);

await sleep(2_000);
const seat = a.client.you.seat;
const sim = a.client.sim;
let claim;
for (let i = 0; i < sim.state.owner.length && !claim; i++) {
  const x = i % sim.state.width;
  const y = Math.floor(i / sim.state.width);
  if (sim.validate({ step: sim.step, ...seat, seq: 0, type: MOVE.CLAIM, x, y })) claim = { x, y };
}
const before = sim.state.empires[seat.empire - 1].tilesOwned;
await a.client.submit(MOVE.CLAIM, claim.x, claim.y);
await waitFor("the claim to land", () => a.client.sim.state.empires[seat.empire - 1].tilesOwned > before);
await waitFor("bob to see it", () => b.client.sim.state.owner[claim.y * b.client.sim.state.width + claim.x] === seat.empire);
console.log(`claim at (${claim.x}, ${claim.y}) landed on both clients`);

await sleep(1_000);
if (a.client.sim.step !== b.client.sim.step) {
  await waitFor("the same step", () => a.client.sim.step === b.client.sim.step, 2_000);
}
if (a.client.sim.hash() !== b.client.sim.hash()) fail("hashes differ while playing");
console.log(`step ${a.client.sim.step}: both clients hash ${a.client.sim.hash().toString(16)}`);

b.socket.close();
await sleep(4_000);
b = connect(bob, id, "bob", b.client);
await waitFor("bob to catch up", () => Math.abs(b.client.sim.step - a.client.sim.step) <= 3);
await sleep(600);
await waitFor("the same step after rejoining", () => a.client.sim.step === b.client.sim.step, 3_000);
if (a.client.sim.hash() !== b.client.sim.hash()) fail("hashes differ after bob rejoined");
console.log(`bob rejoined and caught up: step ${b.client.sim.step}, hash ${b.client.sim.hash().toString(16)}`);

const info = await (await fetch(`${base}/api/games/${id}`)).json();
console.log("room says", info);
a.socket.close();
b.socket.close();
console.log("PASS");
process.exit(0);
