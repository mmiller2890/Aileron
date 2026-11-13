// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EmbeddedBar } from "./EmbeddedBar";

vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedAIProvider: { provider: "claude" },
    selectedSttProvider: { provider: "local-fluidaudio" },
  }),
}));

describe("EmbeddedBar home button", () => {
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

  const renderBar = (
    props: Partial<React.ComponentProps<typeof EmbeddedBar>> = {},
  ) => {
    const onGoHome = vi.fn();
    act(() => {
      root.render(
        <EmbeddedBar
          snapshot={null}
          sendCommand={vi.fn()}
          overlayVisible={false}
          onTogglePopOut={vi.fn()}
          onOpenProviders={vi.fn()}
          onGoHome={onGoHome}
          {...props}
        />,
      );
    });
    return { onGoHome };
  };

  const homeButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("home"),
    ) as HTMLButtonElement;

  it("goes home when clicked", () => {
    const { onGoHome } = renderBar();
    act(() => homeButton().click());
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it("stays available while the bar is popped out", () => {
    const { onGoHome } = renderBar({ overlayVisible: true });
    act(() => homeButton().click());
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });
});
