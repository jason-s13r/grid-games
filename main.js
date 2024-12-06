import { EmpireAttack } from "./src/EmpireAttack";

const game = new EmpireAttack('[game="empire-attack"]');

game.init();

window.game = game;

console.log('## game', window.game);