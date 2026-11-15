// A new player is asked for a name before their first game.
//
// A real engine, because what is being checked is a <dialog>: showModal, the
// form inside it, Enter in the field, and the close event Escape fires.

import { describe, expect, it } from "vitest";
import { NamePrompt } from "../view/NamePrompt";

const mount = () => {
  const dialog = document.createElement("dialog");
  dialog.innerHTML = `
    <form method="dialog">
      <input data-name-prompt-input />
      <p data-name-prompt-shown></p>
      <button type="button" data-name-prompt-skip>Skip</button>
      <button type="submit">Play</button>
    </form>`;
  document.body.append(dialog);
  const saved: string[] = [];
  let asked = 0;
  const prompt = new NamePrompt(dialog, {
    save: (name) => (saved.push(name), name),
    preview: async (name) => `Shown as ${name || "abcd1234"}`,
    asked: () => asked++,
  });
  const input = dialog.querySelector<HTMLInputElement>("[data-name-prompt-input]")!;
  return { dialog, prompt, input, saved, asked: () => asked };
};

describe("the name prompt", () => {
  it("does not open when it is not needed", async () => {
    const { dialog, prompt, asked } = mount();
    await prompt.ask(false);
    expect(dialog.open).toBe(false);
    expect(asked()).toBe(0);
  });

  it("saves the name on Play and lets the game start", async () => {
    const { dialog, prompt, input, saved, asked } = mount();
    const done = prompt.ask(true);
    expect(dialog.open).toBe(true);
    input.value = "kestrel";
    dialog.querySelector("form")!.requestSubmit();
    await done;
    expect(saved).toEqual(["kestrel"]);
    expect(asked()).toBe(1);
    expect(dialog.open).toBe(false);
  });

  it("treats Skip as an answer and saves nothing", async () => {
    const { dialog, prompt, input, saved, asked } = mount();
    const done = prompt.ask(true);
    input.value = "typed but skipped";
    dialog.querySelector<HTMLButtonElement>("[data-name-prompt-skip]")!.click();
    await done;
    expect(saved).toEqual([]);
    expect(asked()).toBe(1);
  });

  it("treats closing the dialog another way as a skip", async () => {
    const { dialog, prompt, saved, asked } = mount();
    const done = prompt.ask(true);
    dialog.close();
    await done;
    expect(saved).toEqual([]);
    expect(asked()).toBe(1);
  });

  it("presses Play, not Skip, when the form is submitted from the field", async () => {
    const { dialog, prompt, input, saved } = mount();
    const done = prompt.ask(true);
    input.value = "osprey";
    // What Enter in the field does: the form's default (first submit) button.
    dialog.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
    await done;
    expect(saved).toEqual(["osprey"]);
  });
});
