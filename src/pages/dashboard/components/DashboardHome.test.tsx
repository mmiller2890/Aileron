// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DashboardHome } from "./DashboardHome";
import { ChatConversation } from "@/types/completion";

const conversation = (id: string, title: string): ChatConversation => ({
  id,
  title,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 60_000,
  messages: [],
});

describe("DashboardHome", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const renderHome = (
    props: Partial<React.ComponentProps<typeof DashboardHome>> = {},
  ) => {
    const handlers = {
      sendCommand: vi.fn(),
      onTogglePopOut: vi.fn(),
      onOpenProviders: vi.fn(),
      onOpenConversation: vi.fn(),
      onOpenAllChats: vi.fn(),
    };
    act(() => {
      root.render(
        <DashboardHome
          snapshot={null}
          conversations={[]}
          providerLabel="claude · local-fluidaudio"
          overlayVisible={false}
          hour={9}
          {...handlers}
          {...props}
        />,
      );
    });
    return handlers;
  };

  const button = (label: string) =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes(label),
    ) as HTMLButtonElement;

  it("greets by time of day and offers both ways to start", () => {
    renderHome();
    expect(container.textContent).toContain("Good morning.");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(button("start capture")).toBeTruthy();
    expect(container.textContent).toContain("claude · local-fluidaudio");
  });

  it("starts a capture from the composer", () => {
    const { sendCommand } = renderHome();
    act(() => button("start capture").click());
    expect(sendCommand).toHaveBeenCalledWith({ action: "start-capture" });
  });

  it("submits a typed question with Enter and clears the box", () => {
    const { sendCommand } = renderHome();
    const textarea = container.querySelector("textarea")!;
    const setValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    act(() => {
      setValue.call(textarea, "  What is a monad?  ");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(sendCommand).toHaveBeenCalledWith({
      action: "submit",
      text: "What is a monad?",
    });
    expect(textarea.value).toBe("");
  });

  it("does not submit an empty question", () => {
    const { sendCommand } = renderHome();
    const textarea = container.querySelector("textarea")!;
    act(() => {
      textarea.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it("lists at most three recent sessions and opens the one clicked", () => {
    const { onOpenConversation, onOpenAllChats } = renderHome({
      conversations: [
        conversation("c1", "Interview with Dana"),
        conversation("c2", "Platform sync"),
        conversation("c3", ""),
        conversation("c4", "Should not show"),
      ],
    });
    expect(container.textContent).toContain("Interview with Dana");
    expect(container.textContent).toContain("Untitled session");
    expect(container.textContent).not.toContain("Should not show");
    act(() => button("Platform sync").click());
    expect(onOpenConversation).toHaveBeenCalledWith("c2");
    act(() => button("all chats").click());
    expect(onOpenAllChats).toHaveBeenCalled();
  });

  it("hides the recent list when there is no history", () => {
    renderHome();
    expect(container.textContent).not.toContain("recent");
  });

  it("replaces the composer with a note while the bar is popped out", () => {
    const { onTogglePopOut } = renderHome({ overlayVisible: true });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("popped out");
    act(() => button("pop in").click());
    expect(onTogglePopOut).toHaveBeenCalled();
  });
});
