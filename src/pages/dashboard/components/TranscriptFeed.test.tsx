// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TranscriptFeed } from "./TranscriptFeed";

const conversation = {
  id: "c1",
  title: "",
  createdAt: 1,
  updatedAt: 2,
  messages: [
    { id: "m1", role: "user" as const, content: "First question", timestamp: 1 },
  ],
};

// jsdom has no layout, so content growth is simulated: the test sets the
// scroll metrics and fires the observer the way the browser would on a resize.
let resizeCallbacks: Array<() => void> = [];
class FakeResizeObserver {
  private callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
  }
  observe() {
    resizeCallbacks.push(this.callback);
  }
  unobserve() {}
  disconnect() {
    resizeCallbacks = resizeCallbacks.filter((cb) => cb !== this.callback);
  }
}

describe("TranscriptFeed live text", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    resizeCallbacks = [];
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
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
    vi.unstubAllGlobals();
  });

  const setMetrics = (
    el: HTMLElement,
    metrics: { scrollHeight: number; clientHeight: number },
  ) => {
    Object.defineProperty(el, "scrollHeight", {
      configurable: true,
      value: metrics.scrollHeight,
    });
    Object.defineProperty(el, "clientHeight", {
      configurable: true,
      value: metrics.clientHeight,
    });
  };
  const contentResized = () => act(() => resizeCallbacks.forEach((cb) => cb()));

  const renderFeed = (props: React.ComponentProps<typeof TranscriptFeed>) => {
    act(() => {
      root.render(<TranscriptFeed {...props} />);
    });
    return container.textContent ?? "";
  };

  it("shows provisional text after the settled turns while live", () => {
    const text = renderFeed({
      conversation,
      live: true,
      partialTranscription: "and the second one is",
    });
    expect(text).toContain("First question");
    expect(text).toContain("hearing");
    expect(text.indexOf("and the second one is")).toBeGreaterThan(
      text.indexOf("First question"),
    );
  });

  it("shows provisional text even before the first settled turn", () => {
    const text = renderFeed({
      conversation: null,
      live: true,
      partialTranscription: "hello",
    });
    expect(text).toContain("hello");
    expect(text).not.toContain("listening · say something");
  });

  it("names the speaker on the provisional line when known", () => {
    const text = renderFeed({
      conversation,
      live: true,
      partialTranscription: "and the second one is",
      partialSpeaker: "Speaker 2",
    });
    expect(text).toContain("speaker 2");
    expect(text).not.toContain("hearing");
  });

  it("hides provisional text when the feed is not live", () => {
    const text = renderFeed({ conversation, partialTranscription: "stale" });
    expect(text).not.toContain("stale");
  });

  it("follows content that grows after render, as a mounted answer fills in", () => {
    renderFeed({ conversation, live: true });
    const feed = container.firstElementChild as HTMLElement;
    // The answer's text lands a render later, with no prop change to react to.
    setMetrics(feed, { scrollHeight: 1000, clientHeight: 200 });
    contentResized();
    expect(feed.scrollTop).toBe(1000);
  });

  it("leaves the reader in place when they have scrolled up", () => {
    renderFeed({ conversation, live: true });
    const feed = container.firstElementChild as HTMLElement;
    setMetrics(feed, { scrollHeight: 1000, clientHeight: 200 });
    feed.scrollTop = 0;
    act(() => {
      feed.dispatchEvent(new Event("scroll"));
    });
    setMetrics(feed, { scrollHeight: 1400, clientHeight: 200 });
    contentResized();
    expect(feed.scrollTop).toBe(0);
  });
});
