// Escaping a string that came off the wire, for the panels that build markup by
// concatenation.
//
// Four characters, which is enough against injection and **not enough against
// everything else**: a name containing U+202E passes through this untouched and
// reverses the rendering of everything after it on the line. That is
// `cleanName`'s job and it runs first — see `protocol/src/names.ts`. This is
// only the second half.

export const escape = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
