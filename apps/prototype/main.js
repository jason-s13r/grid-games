import { EmpireAttack } from "./src/EmpireAttack";

const game = new EmpireAttack('[game="tessera"]');

game.init();

window.game = game;

console.log('## game', window.game);