// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

describe("TranscriptFeed live text", () => {
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

  it("hides provisional text when the feed is not live", () => {
    const text = renderFeed({ conversation, partialTranscription: "stale" });
    expect(text).not.toContain("stale");
  });
});
