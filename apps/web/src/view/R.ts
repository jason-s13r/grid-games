// The prototype's tiny observable, carried forward — it earns its keep for
// control bindings and nothing here needs more than this.

export class R<T> {
  private listeners: Array<(value: T) => void> = [];

  constructor(private current: T) {}

  get value(): T {
    return this.current;
  }

  set value(next: T) {
    this.current = next;
    for (const listener of this.listeners) listener(next);
  }

  update(updater: (value: T) => T): void {
    this.value = updater(this.current);
  }

  /** Fires immediately with the current value, then on every change. */
  listen(callback: (value: T) => void): () => void {
    callback(this.current);
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== callback);
    };
  }
}
