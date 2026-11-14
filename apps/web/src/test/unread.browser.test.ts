// Unread chat on the Chat tab.
//
// On a phone the panels are tabs and the map is where the time goes, so a line
// said while another tab is open has to show up somewhere. The count lives on
// the chat panel (`data-unread`) and the tab bar copies it onto the Chat tab.
// A real engine, because what is being checked is a MutationObserver and the
// `toggle` event a <details> fires when it opens.

import { describe, expect, it } from "vitest";
import type { ChatLine } from "@tessera/room";
import { ChatPanel } from "../view/Chat";
import { Tabs } from "../view/Tabs";

const mount = () => {
  const app = document.createElement("div");
  app.innerHTML = `
    <nav data-tabs></nav>
    <details data-acc="map" open><summary>Map</summary><div>map</div></details>
    <aside data-chat-section hidden>
      <details data-acc="chat"><summary>Chat</summary><div data-chat></div></details>
    </aside>`;
  document.body.append(app);
  const tabs = new Tabs(app, app.querySelector("[data-tabs]")!);
  const chat = new ChatPanel(app.querySelector("[data-chat]")!, app.querySelector("[data-chat-section]")!, () => {});
  const panel = app.querySelector<HTMLDetailsElement>('[data-acc="chat"]')!;
  const tab = () => app.querySelector<HTMLElement>('[data-tab="chat"]');
  return { app, tabs, chat, panel, tab };
};

const line = (key: string, text: string): ChatLine =>
  ({ key, name: key, text, at: Date.now(), channel: "all", empire: 1 });

/** MutationObserver callbacks run as microtasks; let them. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("unread chat", () => {
  it("counts lines from other people while the chat is shut, on the panel and its tab", async () => {
    const { chat, panel, tab } = mount();
    chat.open([line("them", "history is not news")], "me", true);
    await settle();
    expect(panel.hasAttribute("data-unread")).toBe(false);

    chat.heard([line("them", "hello"), line("me", "my own line"), line("them", "anyone?")], "me");
    await settle();
    expect(panel.getAttribute("data-unread")).toBe("2");
    expect(tab()?.getAttribute("data-unread")).toBe("2");
    expect(tab()?.getAttribute("aria-label")).toBe("Chat, 2 unread");
  });

  it("clears when the chat is opened, and does not count while it is open", async () => {
    const { app, chat, panel, tab } = mount();
    chat.open([], "me", true);
    chat.heard([line("them", "hello")], "me");
    await settle();
    expect(tab()?.getAttribute("data-unread")).toBe("1");

    const toggled = new Promise((resolve) => panel.addEventListener("toggle", resolve, { once: true }));
    // On a phone the tab opens it; on a wide screen, its heading.
    if (app.dataset.tabbed === "on") tab()!.click();
    else panel.open = true;
    await toggled; // `toggle` is queued, not fired as `open` is set
    await settle();
    expect(panel.hasAttribute("data-unread")).toBe(false);
    expect(tab()?.hasAttribute("data-unread")).toBe(false);

    chat.heard([line("them", "read as it arrives")], "me");
    await settle();
    expect(panel.hasAttribute("data-unread")).toBe(false);
  });

  it("starts again from nothing in the next game", async () => {
    const { chat, panel } = mount();
    chat.open([], "me", true);
    chat.heard([line("them", "one"), line("them", "two")], "me");
    chat.close();
    chat.open([], "me", true);
    expect(panel.hasAttribute("data-unread")).toBe(false);
  });
});
