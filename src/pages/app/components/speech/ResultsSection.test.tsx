// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ResultsSection } from "./ResultsSection";

const conversation = {
  id: "c1",
  title: "",
  createdAt: 1,
  updatedAt: 2,
  messages: [],
};

describe("ResultsSection live text", () => {
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

  const renderSection = (
    props: Partial<React.ComponentProps<typeof ResultsSection>>,
  ) => {
    act(() => {
      root.render(
        <ResultsSection
          lastTranscription=""
          lastAIResponse=""
          isAIProcessing={false}
          conversation={conversation}
          conversationMode={false}
          setConversationMode={() => {}}
          {...props}
        />,
      );
    });
    return container.textContent ?? "";
  };

  it("keeps the settled question with its answer while a new turn is heard", () => {
    const text = renderSection({
      lastTranscription: "What was the hardest decision?",
      lastAIResponse: "Rewriting the build system.",
      currentSpeaker: "Speaker 1",
      partialTranscription: "and how did you",
      partialSpeaker: "Speaker 2",
    });
    expect(text).toContain("What was the hardest decision?");
    expect(text).toContain("speaker 1");
    expect(text).toContain("and how did you");
    expect(text).toContain("speaker 2");
    // The turn in progress follows the answer it does not belong to.
    expect(text.indexOf("and how did you")).toBeGreaterThan(
      text.indexOf("Rewriting the build system."),
    );
  });

  it("labels the turn in progress as hearing until a speaker is known", () => {
    const text = renderSection({ partialTranscription: "hello there" });
    expect(text).toContain("hearing");
    expect(text).toContain("hello there");
  });

  it("renders nothing when there is no text, answer, or turn in progress", () => {
    expect(renderSection({})).toBe("");
  });
});

// jsdom has no layout, so the answer's position is simulated: the test says
// where the answer ends and fires the observer the way a resize would.
describe("ResultsSection answer following", () => {
  const VIEWPORT_BOTTOM = 300;
  let viewport: HTMLDivElement;
  let root: Root;
  let answerBottom: number;
  let resizeCallbacks: Array<() => void>;

  beforeEach(() => {
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    answerBottom = 0;
    resizeCallbacks = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        private callback: () => void;
        constructor(callback: () => void) {
          this.callback = callback;
        }
        observe() {
          resizeCallbacks.push(this.callback);
        }
        unobserve() {}
        disconnect() {
          resizeCallbacks = resizeCallbacks.filter(
            (cb) => cb !== this.callback,
          );
        }
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: Element) {
        const bottom = this === viewport ? VIEWPORT_BOTTOM : answerBottom;
        return { bottom } as DOMRect;
      },
    );
    viewport = document.createElement("div");
    viewport.setAttribute("data-radix-scroll-area-viewport", "");
    document.body.appendChild(viewport);
    root = createRoot(viewport);
  });

  afterEach(() => {
    act(() => root.unmount());
    viewport.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const renderSection = (
    props: Partial<React.ComponentProps<typeof ResultsSection>>,
  ) =>
    act(() => {
      root.render(
        <ResultsSection
          lastTranscription="What was the hardest decision?"
          lastAIResponse=""
          isAIProcessing={false}
          conversation={conversation}
          conversationMode={false}
          setConversationMode={() => {}}
          {...props}
        />,
      );
    });
  const answerGrewTo = (bottom: number) => {
    answerBottom = bottom;
    act(() => resizeCallbacks.forEach((cb) => cb()));
  };
  const userScrolled = () =>
    act(() => {
      viewport.dispatchEvent(new Event("scroll"));
    });

  it("scrolls down to keep the end of a growing answer in view", () => {
    renderSection({ isAIProcessing: true, lastAIResponse: "Rewriting" });
    answerGrewTo(VIEWPORT_BOTTOM + 120);
    expect(viewport.scrollTop).toBe(120);
  });

  it("does not move the panel while the answer still fits", () => {
    renderSection({ isAIProcessing: true, lastAIResponse: "Rewriting" });
    answerGrewTo(VIEWPORT_BOTTOM - 50);
    expect(viewport.scrollTop).toBe(0);
  });

  it("stops following once the reader scrolls back up the answer", () => {
    renderSection({ isAIProcessing: true, lastAIResponse: "Rewriting" });
    answerBottom = VIEWPORT_BOTTOM + 400;
    userScrolled();
    answerGrewTo(VIEWPORT_BOTTOM + 500);
    expect(viewport.scrollTop).toBe(0);
  });

  it("follows again when the next answer starts", () => {
    renderSection({ isAIProcessing: true, lastAIResponse: "Rewriting" });
    answerBottom = VIEWPORT_BOTTOM + 400;
    userScrolled();
    renderSection({ isAIProcessing: false, lastAIResponse: "Rewriting" });
    renderSection({ isAIProcessing: true, lastAIResponse: "" });
    answerGrewTo(VIEWPORT_BOTTOM + 60);
    expect(viewport.scrollTop).toBe(60);
  });
});
