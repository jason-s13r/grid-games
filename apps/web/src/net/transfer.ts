// Moving a player between two of your devices.
//
// The device that wants the player shows a four-letter code; the device that
// has it types the code in. Both make a key for the occasion, swap the public
// halves through the Worker, and derive the same secret from them. Both show
// two pictures made from the two public halves: if they match, nobody sat in
// between. The device that has the player then sends it (its backup code and
// name) sealed with the secret, and the Worker, which passes it on, cannot
// read it. See apps/worker/src/pairing.ts.

import { fromBase64Url, sha256, toBase64Url, utf8, fromUtf8, concat } from "@tessera/protocol";

/** Letters that do not look like one another or like digits. */
const LETTERS = "ACDEFHJKMNPRTUVWXY";

/** What the two screens show to be compared. */
const PICTURES = [
  "🦊", "🐢", "🦉", "🐙", "🦋", "🐝", "🦀", "🐳", "🦔", "🐸", "🦜", "🐌", "🦒", "🐧", "🦩", "🐞",
  "🍄", "🌵", "🌻", "🍋", "🍉", "🥕", "🌶️", "🍒", "⚓", "🎈", "🔔", "🎲", "🧩", "🪁", "⛵", "🚂",
];

export type TransferState =
  | { stage: "waiting"; code: string }
  | { stage: "check"; pictures: string }
  | { stage: "sent" }
  | { stage: "received"; backup: string; name: string }
  | { stage: "failed"; error: string };

type Message =
  | { t: "pub"; pub: string }
  | { t: "sealed"; iv: string; data: string }
  | { t: "joined" }
  | { t: "gone" }
  | { t: "error"; error: string };

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

export function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => LETTERS[b % LETTERS.length]).join("");
}

/** A code as typed: upper case, letters only. */
export const cleanCode = (text: string): string => text.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4);

/** One side of a transfer. `receive` on the device that wants the player,
 *  `send` on the one that has it; `state` reports each step. */
export class Transfer {
  private ws: WebSocket | undefined;
  private mine: CryptoKeyPair | undefined;
  private myPub = "";
  private secret: CryptoKey | undefined;
  private finished = false;
  private arriving = false;

  private constructor(
    private readonly side: "new" | "old",
    readonly code: string,
    private readonly state: (state: TransferState) => void,
    private readonly player?: { backup: string; name: string },
  ) {}

  /** Show a code and wait for the player to arrive. */
  static receive(state: (s: TransferState) => void): Transfer {
    const transfer = new Transfer("new", newCode(), state);
    void transfer.open();
    return transfer;
  }

  /** Join the code another device shows, to send it this player. */
  static send(code: string, player: { backup: string; name: string }, state: (s: TransferState) => void): Transfer {
    const transfer = new Transfer("old", cleanCode(code), state, player);
    void transfer.open();
    return transfer;
  }

  /** The pictures matched: send the player across. */
  async confirm(): Promise<void> {
    if (!this.secret || !this.player || !this.ws) return;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = utf8(JSON.stringify(this.player));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.secret, plain));
    this.send({ t: "sealed", iv: toBase64Url(iv), data: toBase64Url(data) });
    this.finish({ stage: "sent" });
  }

  cancel(): void {
    this.finished = true;
    this.ws?.close();
  }

  private async open(): Promise<void> {
    this.mine = await crypto.subtle.generateKey(ECDH, false, ["deriveBits"]);
    this.myPub = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", this.mine.publicKey)));
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/api/pair/${this.code}/ws?as=${this.side}`);
    this.ws = ws;
    ws.onopen = () => {
      if (this.side === "new") this.state({ stage: "waiting", code: this.code });
      else this.send({ t: "pub", pub: this.myPub });
    };
    ws.onmessage = (event) => void this.receive(JSON.parse(String(event.data)) as Message);
    ws.onclose = () => this.arriving || this.finish({ stage: "failed", error: "The connection closed. Try again with a new code." });
  }

  private async receive(message: Message): Promise<void> {
    switch (message.t) {
      case "error":
        return this.finish({ stage: "failed", error: `The other device could not be reached: ${message.error}.` });
      case "gone":
        if (this.arriving) return;
        return this.finish({ stage: "failed", error: "The other device left before it finished." });
      case "joined":
        // The old device is here; it needs this side's half.
        return this.send({ t: "pub", pub: this.myPub });
      case "pub":
        return this.agree(message.pub);
      case "sealed":
        // The sender leaves as soon as it has sent, and its going must not
        // overtake the player while it is being unsealed.
        this.arriving = true;
        return this.open_(message);
    }
  }

  private async agree(theirPub: string): Promise<void> {
    const raw = fromBase64Url(theirPub);
    if (!raw || !this.mine) return this.finish({ stage: "failed", error: "The other device sent something unreadable." });
    const theirs = await crypto.subtle.importKey("raw", raw as BufferSource, ECDH, false, []);
    const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: theirs }, this.mine.privateKey, 256);
    // Both sides put the new device's half first, so both hash the same bytes.
    const mineRaw = fromBase64Url(this.myPub)!;
    const pair = this.side === "new" ? concat(mineRaw, raw) : concat(raw, mineRaw);
    const salt = await sha256(pair);
    const base = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
    this.secret = await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: utf8("tessera/transfer/1") as BufferSource },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const digest = await sha256(concat(utf8("tessera/pictures/1"), pair));
    const pictures = `${PICTURES[digest[0]! % PICTURES.length]} ${PICTURES[digest[1]! % PICTURES.length]}`;
    this.state({ stage: "check", pictures });
  }

  private async open_(message: { iv: string; data: string }): Promise<void> {
    const iv = fromBase64Url(message.iv);
    const data = fromBase64Url(message.data);
    if (!this.secret || !iv || !data) return this.finish({ stage: "failed", error: "The player arrived unreadable." });
    try {
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, this.secret, data as BufferSource);
      const player = JSON.parse(fromUtf8(new Uint8Array(plain))) as { backup?: unknown; name?: unknown };
      if (typeof player.backup !== "string") throw new Error("no player in it");
      this.finish({ stage: "received", backup: player.backup, name: typeof player.name === "string" ? player.name : "" });
    } catch {
      this.finish({ stage: "failed", error: "The player arrived unreadable." });
    }
  }

  private send(message: Message): void {
    this.ws?.send(JSON.stringify(message));
  }

  private finish(state: TransferState): void {
    if (this.finished) return;
    this.finished = true;
    this.state(state);
    this.ws?.close();
  }
}
