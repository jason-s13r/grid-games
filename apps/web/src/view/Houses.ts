// Picking a house: the lobby's question, and a newcomer's when they take an
// empire nobody holds.
//
// A house is a banner — a name, two colours and a pattern — and picking one is
// how a player says who they will be. Picking the same house as somebody else
// is joining them; the empire number it ends up as is the room's business.

import type { Banner, BannerId } from "@tessera/sim";
import { BANNERS } from "./palette";
import { escape } from "./escape";

/** A small flag, drawn with the board's own tile pattern. `size` in px. */
export function flag(banner: Banner, size?: number): string {
  const style = size ? ` style="--s:${size}px"` : "";
  return `<span class="flag tile p-${banner.pattern}" data-banner="${banner.id}"${style} aria-hidden="true"></span>`;
}

export interface House {
  banner: Banner;
  /** Who has picked it, already escaped. */
  who: string[];
  mine: boolean;
  /** Can be picked by this player now. */
  open: boolean;
  /** A word on why not, or what it is. */
  note?: string;
}

/** Every house as a button. `attr` is the data attribute a click is read
 *  from: the button carries the banner id in it. */
export function housesHtml(houses: House[], attr: string): string {
  return `<div class="houses">${houses
    .map((house) => {
      const { banner } = house;
      const who = house.who.length ? `<span class="house-who">${house.who.join(", ")}</span>` : "";
      const note = house.note ? `<span class="house-note">${escape(house.note)}</span>` : "";
      return `<button type="button" class="house${house.mine ? " mine" : ""}${house.who.length ? " taken" : ""}"
        data-${attr}="${banner.id}"${house.open || house.mine ? "" : " disabled"}
        aria-pressed="${house.mine}" title="${escape(banner.name)}">
        ${flag(banner)}
        <span class="house-text"><strong>${escape(banner.name)}</strong>${who}${note}</span>
      </button>`;
    })
    .join("")}</div>`;
}

/** The houses a lobby offers, picked ones first. */
export function lobbyHouses(
  players: ReadonlyArray<{ key: string; banner: BannerId | null; html: string }>,
  me: string,
  empires: number,
  seatsPerEmpire: number,
): House[] {
  const mine = players.find((p) => p.key === me)?.banner ?? null;
  const others = players.filter((p) => p.key !== me && p.banner !== null);
  const pickedByOthers = new Set(others.map((p) => p.banner));
  const roomForNew = pickedByOthers.size < empires;
  const houses = BANNERS.map((banner): House => {
    const here = players.filter((p) => p.banner === banner.id);
    const othersHere = here.filter((p) => p.key !== me).length;
    const full = othersHere >= seatsPerEmpire;
    const open = !full && (othersHere > 0 || roomForNew);
    const note = banner.id === mine ? undefined : full ? "full" : othersHere > 0 ? "join" : open ? undefined : "no empires left";
    return { banner, who: here.map((p) => p.html), mine: banner.id === mine, open, ...(note ? { note } : {}) };
  });
  return [...houses.filter((h) => h.who.length), ...houses.filter((h) => !h.who.length)];
}
