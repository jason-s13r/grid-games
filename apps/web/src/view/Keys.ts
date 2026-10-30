// Your player, managed by you: back it up, move it to another device, bring
// it back from a backup, or take your name out of the records. Everything
// here lives in one dialog, opened from the start page's Settings.
//
// A player is a key kept in this browser. There is no account behind it, so
// these are the only ways to keep it, and the backup code is as good as the
// player: whoever has it plays as you.

import qrcode from "qrcode-generator";
import { Identity, displayName, fingerprint, forgetPayload } from "@tessera/protocol";
import { dropIdentity, myIdentity, myName, setMyName, useIdentity } from "../net/identity";
import { Transfer, cleanCode } from "../net/transfer";
import type { TransferState } from "../net/transfer";

const escape = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export class KeysDialog {
  private transfer: Transfer | undefined;

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly body: HTMLElement,
  ) {
    dialog.addEventListener("close", () => {
      this.transfer?.cancel();
      this.transfer = undefined;
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
      const close = (event.target as HTMLElement).closest("[data-keys-close]");
      if (close) dialog.close();
    });
  }

  /** Who this device plays as, for the line in Settings. */
  static async who(): Promise<string> {
    const identity = await myIdentity();
    return displayName(myName(), await fingerprint(identity.key));
  }

  private show(title: string, html: string): void {
    this.body.innerHTML = `<h2>${title}</h2>${html}`;
    if (!this.dialog.open) this.dialog.showModal();
  }

  private bind<T extends HTMLElement = HTMLElement>(selector: string): T {
    return this.body.querySelector<T>(selector)!;
  }

  // --- back up -----------------------------------------------------------------

  async backup(): Promise<void> {
    const identity = await myIdentity();
    const code = await identity.toBackup();
    const link = `${location.origin}/#restore=${code}`;
    const qr = qrcode(0, "M");
    qr.addData(link);
    qr.make();
    this.show(
      "Back up your player",
      `<p>Scan this with another device, or keep the link somewhere safe. Opening
       it puts this player on that device, with your games and your record.</p>
       <p class="keys-warn">Anyone with this link or code plays as you. Keep it to yourself.</p>
       <div class="keys-qr">${qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true })}</div>
       <div class="keys-row">
         <button class="btn" type="button" data-keys-copy>Copy the link</button>
         <button class="btn" type="button" data-keys-reveal>Show the code</button>
       </div>
       <code class="keys-code" data-keys-code hidden>${escape(code)}</code>
       <button class="btn primary" type="button" data-keys-close>Done</button>`,
    );
    this.bind("[data-keys-copy]").onclick = async (event) => {
      await navigator.clipboard?.writeText(link).catch(() => undefined);
      (event.target as HTMLElement).textContent = "Copied";
    };
    this.bind("[data-keys-reveal]").onclick = () => {
      const shown = this.bind("[data-keys-code]");
      shown.hidden = !shown.hidden;
    };
  }

  // --- restore -----------------------------------------------------------------

  async restore(prefill = ""): Promise<void> {
    const who = await KeysDialog.who();
    this.show(
      "Use a backup code",
      `<p>Paste a backup code or link to play as that player on this device.</p>
       <textarea class="keys-input" rows="3" spellcheck="false" autocomplete="off" data-keys-input
         placeholder="T1… or https://tessera.qot.nz/#restore=…">${escape(prefill)}</textarea>
       <p class="keys-warn">This device plays as <strong>${escape(who)}</strong> now. That player
       is replaced here; back it up first if you want to keep it.</p>
       <p class="keys-error" data-keys-error hidden></p>
       <div class="keys-row">
         <button class="btn primary" type="button" data-keys-go>Use this player</button>
         <button class="btn" type="button" data-keys-close>Cancel</button>
       </div>`,
    );
    this.bind("[data-keys-go]").onclick = async () => {
      const error = this.bind("[data-keys-error]");
      const identity = await Identity.fromBackup(this.bind<HTMLTextAreaElement>("[data-keys-input]").value);
      if (!identity) {
        error.hidden = false;
        error.textContent = "That is not a backup code, or part of it is missing.";
        return;
      }
      if (identity.key === (await myIdentity()).key) {
        error.hidden = false;
        error.textContent = "That is already the player on this device.";
        return;
      }
      await this.become(identity, await nameOf(identity.key));
    };
  }

  /** Make this device play as `identity`, and start the page again with it. */
  private async become(identity: Identity, name: string): Promise<void> {
    await useIdentity(identity);
    setMyName(name);
    location.href = "/";
  }

  // --- move between devices ----------------------------------------------------

  move(): void {
    this.show(
      "Move between devices",
      `<p>Play as the same player on two devices: one shows a code, the other
       types it in.</p>
       <div class="keys-choices">
         <button class="btn" type="button" data-keys-to-here>
           <strong>Bring my player here</strong><span>This device shows a code.</span></button>
         <button class="btn" type="button" data-keys-from-here>
           <strong>Send my player from here</strong><span>Type the code the other device shows.</span></button>
       </div>
       <button class="btn" type="button" data-keys-close>Cancel</button>`,
    );
    this.bind("[data-keys-to-here]").onclick = () => this.receive();
    this.bind("[data-keys-from-here]").onclick = () => this.sendForm();
  }

  private receive(): void {
    this.show("Bring my player here", `<p class="hint">Opening a code…</p>`);
    this.transfer = Transfer.receive((state) => void this.received(state));
  }

  private async received(state: TransferState): Promise<void> {
    switch (state.stage) {
      case "waiting":
        return this.show(
          "Bring my player here",
          `<p>On the device that has your player, open Settings, choose <strong>Move between
           devices</strong>, then <strong>Send my player from here</strong>, and type:</p>
           <p class="keys-big">${state.code}</p>
           <p class="hint">The code works for ten minutes.</p>
           <button class="btn" type="button" data-keys-close>Cancel</button>`,
        );
      case "check":
        return this.show(
          "Bring my player here",
          `<p>The other device should show these two pictures:</p>
           <p class="keys-big">${state.pictures}</p>
           <p class="hint">If they match, press Send on the other device. If they do not,
           cancel: something is in between.</p>
           <button class="btn" type="button" data-keys-close>Cancel</button>`,
        );
      case "received": {
        const identity = await Identity.fromBackup(state.backup);
        if (!identity) return this.failed("The player arrived, but it is not one this device can use.");
        return this.become(identity, state.name);
      }
      case "failed":
        return this.failed(state.error);
    }
  }

  private sendForm(): void {
    this.show(
      "Send my player from here",
      `<p>Type the code the other device shows.</p>
       <input class="keys-input keys-code-input" maxlength="4" autocapitalize="characters" autocomplete="off"
         spellcheck="false" placeholder="ABCD" data-keys-input />
       <p class="keys-error" data-keys-error hidden></p>
       <div class="keys-row">
         <button class="btn primary" type="button" data-keys-go>Connect</button>
         <button class="btn" type="button" data-keys-close>Cancel</button>
       </div>`,
    );
    const input = this.bind<HTMLInputElement>("[data-keys-input]");
    input.focus();
    input.oninput = () => (input.value = cleanCode(input.value));
    const go = async () => {
      if (input.value.length !== 4) return;
      const identity = await myIdentity();
      const player = { backup: await identity.toBackup(), name: myName() };
      this.show("Send my player from here", `<p class="hint">Connecting…</p>`);
      this.transfer = Transfer.send(input.value, player, (state) => this.sending(state));
    };
    this.bind("[data-keys-go]").onclick = go;
    input.onkeydown = (event) => {
      if (event.key === "Enter") void go();
    };
  }

  private sending(state: TransferState): void {
    switch (state.stage) {
      case "check":
        this.show(
          "Send my player from here",
          `<p>Check the other device shows the same two pictures:</p>
           <p class="keys-big">${state.pictures}</p>
           <label class="keys-check"><input type="checkbox" data-keys-signout />
             Sign this device out afterwards (it starts again as a new player)</label>
           <div class="keys-row">
             <button class="btn primary" type="button" data-keys-go>They match: send</button>
             <button class="btn" type="button" data-keys-close>They do not</button>
           </div>`,
        );
        this.bind("[data-keys-go]").onclick = () => {
          this.signOutAfter = this.bind<HTMLInputElement>("[data-keys-signout]").checked;
          void this.transfer?.confirm();
        };
        return;
      case "sent":
        if (this.signOutAfter) {
          dropIdentity();
          location.href = "/";
          return;
        }
        this.show(
          "Sent",
          `<p>Your player is on the other device now, and still on this one.</p>
           <button class="btn primary" type="button" data-keys-close>Done</button>`,
        );
        return;
      case "failed":
        this.failed(state.error);
        return;
      default:
        return;
    }
  }

  private signOutAfter = false;

  private failed(error: string): void {
    this.transfer = undefined;
    this.show(
      "That did not work",
      `<p>${escape(error)}</p><button class="btn primary" type="button" data-keys-close>Close</button>`,
    );
  }

  // --- delete ------------------------------------------------------------------

  async remove(): Promise<void> {
    const who = await KeysDialog.who();
    this.show(
      "Delete my data",
      `<p>Takes the name <strong>${escape(who)}</strong> out of the game records, out of
       every game it is in and out of their chat. Finished games keep your moves
       and results, under your key's fingerprint and no name.</p>
       <label class="keys-check"><input type="checkbox" data-keys-signout />
         Also sign this device out (it starts again as a new player, and your games
         here can't be resumed without a backup)</label>
       <p class="keys-error" data-keys-error hidden></p>
       <div class="keys-row">
         <button class="btn danger" type="button" data-keys-go>Delete my data</button>
         <button class="btn" type="button" data-keys-close>Cancel</button>
       </div>`,
    );
    this.bind("[data-keys-go]").onclick = async (event) => {
      const button = event.target as HTMLButtonElement;
      button.disabled = true;
      const signOut = this.bind<HTMLInputElement>("[data-keys-signout]").checked;
      const identity = await myIdentity();
      const at = Date.now();
      const sig = await identity.sign(forgetPayload(identity.key, at));
      const response = await fetch(`/api/players/${encodeURIComponent(identity.key)}/forget`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ at, sig }),
      }).catch(() => undefined);
      if (!response?.ok) {
        button.disabled = false;
        const error = this.bind("[data-keys-error]");
        error.hidden = false;
        error.textContent = `That did not go through${response ? ` (the server said ${response.status})` : ""}. Try again.`;
        return;
      }
      setMyName("");
      if (signOut) dropIdentity();
      location.href = "/";
    };
  }
}

/** The name the records hold for a key, to carry over with it. */
async function nameOf(key: string): Promise<string> {
  try {
    const response = await fetch(`/api/players/${encodeURIComponent(key)}`, { cache: "no-cache" });
    if (!response.ok) return "";
    const body = (await response.json()) as { name?: string | null };
    const name = body.name ?? "";
    // The records' stand-in for no name is not a name to keep.
    return name.startsWith("player ") ? "" : name;
  } catch {
    return "";
  }
}
