export const getNeighbours = (x, y) => [
  [x, y],
  [x, y + 1],
  [x, y - 1],
  [x + 1, y],
  [x - 1, y],
];