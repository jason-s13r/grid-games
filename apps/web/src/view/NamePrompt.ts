// Asking a new player for a name, before their first game.
//
// A name is optional: without one, other players see the fingerprint, which is
// eight hex characters nobody remembers. The field for it sits in the account
// dialog behind the gear, where a first-time player does not look, so the first
// game asks. Once: skipping is an answer, and the gear is still there.

export interface NamePromptHandlers {
  /** The name as typed; returns it as it will be shown (cleaned). */
  save: (name: string) => string;
  /** "Shown as name#fingerprint", for the preview under the field. */
  preview: (name: string) => Promise<string>;
  /** Remember that this browser has been asked. */
  asked: () => void;
}

export class NamePrompt {
  private readonly input: HTMLInputElement;
  private readonly shown: HTMLElement;
  private waiting: (() => void)[] = [];

  constructor(
    private readonly dialog: HTMLDialogElement,
    private readonly handlers: NamePromptHandlers,
  ) {
    this.input = dialog.querySelector<HTMLInputElement>("[data-name-prompt-input]")!;
    this.shown = dialog.querySelector<HTMLElement>("[data-name-prompt-shown]")!;

    dialog.querySelector("form")!.addEventListener("submit", (event) => {
      event.preventDefault();
      this.finish(this.input.value);
    });
    // A button of its own rather than a second submit: Enter in the field
    // presses the form's first submit button, and that should be Play.
    dialog.querySelector("[data-name-prompt-skip]")!.addEventListener("click", () => this.finish(""));
    this.input.addEventListener("input", () => void this.preview());
    // Escape, or the browser closing it some other way, is a skip.
    dialog.addEventListener("close", () => this.release());
  }

  /** Resolves once the player has a name or has said they do not want one.
   *  Straight away if that has already happened. */
  ask(needed: boolean): Promise<void> {
    if (!needed) return Promise.resolve();
    return new Promise((resolve) => {
      this.waiting.push(resolve);
      if (this.dialog.open) return;
      this.input.value = "";
      void this.preview();
      this.dialog.showModal();
      this.input.focus();
    });
  }

  private async preview(): Promise<void> {
    this.shown.textContent = await this.handlers.preview(this.input.value);
  }

  private finish(name: string): void {
    if (name.trim()) this.handlers.save(name);
    this.dialog.close();
  }

  private release(): void {
    this.handlers.asked();
    const waiting = this.waiting;
    this.waiting = [];
    for (const resolve of waiting) resolve();
  }
}
