// Just enough PeerJS to have the one property the loopback network lacks: a
// message size ceiling that raises on the sender.

/** PeerJS's chunkedMTU. The value is 16300 because Firefox to Chrome truncates
 *  at 16384; the JSON serialisation path refuses anything larger outright
 *  rather than chunking it. */
const FAKE_MTU = 16_300;

type Handler = (arg: never) => void;

class Emitter {
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }

  emit(event: string, arg?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) (handler as (a: unknown) => void)(arg);
  }
}

export class FakeConnection extends Emitter {
  other?: FakeConnection;

  constructor(readonly peer: string) {
    super();
  }

  send(data: unknown): void {
    // Serialised before the check and again on delivery, exactly as a real
    // channel does — a mesh that accidentally shared an object with the sender
    // would otherwise pass this test and fail on the wire.
    const text = JSON.stringify(data);
    if (text.length > FAKE_MTU) throw new Error("Message too big for JSON channel");
    queueMicrotask(() => this.other?.emit("data", JSON.parse(text)));
  }

  close(): void {
    this.emit("close");
  }
}

export class FakePeer extends Emitter {
  static readonly all = new Map<string, FakePeer>();
  readonly id: string;
  /** Kept because PeerJS merges `config` one level deep: what we pass is not
   *  added to its defaults, it replaces them. See ice.test.ts. */
  readonly options?: { config?: RTCConfiguration };

  constructor(id?: string, options?: { config?: RTCConfiguration }) {
    super();
    this.id = id ?? `peer${FakePeer.all.size}`;
    this.options = options;
    FakePeer.all.set(this.id, this);
    queueMicrotask(() => this.emit("open", this.id));
  }

  connect(to: string): FakeConnection {
    const target = FakePeer.all.get(to)!;
    const here = new FakeConnection(to);
    const there = new FakeConnection(this.id);
    here.other = there;
    there.other = here;
    // The dialer's handlers are registered synchronously by PeerMesh.adopt on
    // the object returned here, so "open" must not fire before this returns.
    queueMicrotask(() => {
      target.emit("connection", there);
      queueMicrotask(() => {
        there.emit("open");
        here.emit("open");
      });
    });
    return here;
  }

  destroy(): void {}
}
