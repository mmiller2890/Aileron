// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
