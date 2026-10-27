// Game time, in one place.
//
// The step number is the one clock every peer already agrees on, so two players
// comparing screenshots see the same stamp. There were two formatters for it —
// `Chat`'s module-private `mm:ss` and `Controls`' `h:mm:ss` — and **neither can
// render a ten-day game**: the first has an unbounded minute field, so day ten
// reads `14400:00`, and the second has no days at all. Durations made ten-day
// games ordinary, so this is the plan that needs one formatter with days in it.

import { STEPS_PER_SECOND } from "@tessera/sim";

/** A step as game time. Days appear only once there are any, so a short game
 *  reads exactly as it always did. */
export function stamp(step: number): string {
  const seconds = Math.max(0, Math.floor(step / STEPS_PER_SECOND));
  const ss = seconds % 60;
  const minutes = Math.floor(seconds / 60);
  const mm = minutes % 60;
  const hours = Math.floor(minutes / 60);
  const hh = hours % 24;
  const days = Math.floor(hours / 24);

  const pad = (n: number): string => String(n).padStart(2, "0");
  if (days > 0) return `${days}d ${pad(hh)}:${pad(mm)}:${pad(ss)}`;
  if (hours > 0) return `${hours}:${pad(mm)}:${pad(ss)}`;
  return `${minutes}:${pad(ss)}`;
}

/** How long something lasted, in the units a person would say it in. Used for
 *  "you were away for 8h 12m", which is the honest thing a reloaded tab can
 *  tell a returning player about the gap. */
export function span(steps: number): string {
  const seconds = Math.max(0, Math.round(steps / STEPS_PER_SECOND));
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}
