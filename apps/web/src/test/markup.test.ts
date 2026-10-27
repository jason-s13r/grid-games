// The selectors the client picks, against the markup it picks them out of.
//
// `main.ts` reaches into the page sixty-odd times through `pick()`, which
// throws when a selector matches nothing. Every one of those is a hard failure
// on load — a blank screen, not a degraded one — and until now nothing checked
// that the two files still agreed: `index.html` is data to the suite, and the
// tests that touch the DOM build their own.
//
// So renaming an attribute in the markup, or deleting a card the client still
// reads, was a change the whole suite would let through. **That is exactly the
// shape of the saved-game merge**, which moved one picker and removed another,
// and it should not have been possible to get wrong silently.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${name}`, import.meta.url)), "utf8");

const html = read("index.html");
const main = read("src/main.ts");

/** Every `pick("[data-…]")` in the client, as written. Attribute selectors
 *  only: `pick(".app")` and the like are class selectors on structure that has
 *  no other reason to move. */
const picked = [...main.matchAll(/pick<[^>]*>\(\s*(["'])(\[data-[^\]]*\])\1/g)].map(
  (found) => found[2]!,
);

/** `[data-x]` or `[data-x="y"]` → the text that has to appear in the markup. */
const asAttribute = (selector: string): string => {
  const inner = selector.slice(1, -1);
  const [name, value] = inner.split("=");
  return value ? `${name}=${value.replaceAll("'", '"')}` : name!;
};

describe("the client and the page it reads", () => {
  it("finds enough selectors to be checking something", () => {
    expect(picked.length).toBeGreaterThan(20);
  });

  it("picks nothing the markup does not carry", () => {
    const missing = picked.filter((selector) => !html.includes(asAttribute(selector)));
    expect(missing, "in index.html").toEqual([]);
  });
});
