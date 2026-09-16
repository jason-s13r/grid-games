// Chaining a handler onto a `Lockstep` hook, instead of taking it.
//
// Every hook on `Lockstep` is a single optional field, and there are already
// four owners competing for six of them: `OnlineGame` takes `onEjection`,
// `onDesync` and `onHalt`, `main.ts` takes `onMessage` and `onSeated`, and
// `Archive` takes three by chaining. Assignment is therefore not a way to add a
// listener — it is a way to silently remove somebody else's.
//
// `Archive.attach` already knew this and said so:
//
// > Existing handlers are chained rather than replaced: the client sets
// > `onMessage` to draw the chat log long before anybody asks for an archive,
// > and quietly stealing that callback would empty the panel.
//
// And the client then did it in the other direction — `archive.attach(driver)`
// installed a wrapper around `onMessage: undefined`, and eighteen lines later
// `driver.onMessage = …` overwrote the wrapper. **Every archive this client
// produced carried no chat log**, and the suite could not see it because the
// archive tests wire the harness themselves and never run `main.ts`.
//
// So: nothing in this client assigns a hook. It taps one.

/** Add `next` to whatever `owner[hook]` already is, and return the undo.
 *
 *  The existing handler runs first, because it was there first and the caller
 *  that installed it is entitled to its ordering. A throw from either does not
 *  stop the other: a listener is a reader, and a reader that fails must not take
 *  the simulation or the archive with it. */
export function tap<T extends object, K extends keyof T>(
  owner: T,
  hook: K,
  next: T[K] extends ((...args: infer A) => void) | undefined
    ? (...args: A) => void
    : never,
): () => void {
  const before = owner[hook] as unknown as ((...args: unknown[]) => void) | undefined;
  const chained = ((...args: unknown[]): void => {
    try {
      before?.(...args);
    } catch {
      // Somebody else's listener. Not ours to fail for.
    }
    try {
      (next as (...a: unknown[]) => void)(...args);
    } catch {
      // Nor ours to fail from.
    }
  }) as unknown as T[K];

  owner[hook] = chained;
  return () => {
    // Only if nobody has tapped on top of us. Unwinding out of order would
    // restore a handler that predates somebody else's, which is the bug this
    // file exists to stop rather than a tidy-up.
    if (owner[hook] === chained) owner[hook] = before as unknown as T[K];
  };
}
