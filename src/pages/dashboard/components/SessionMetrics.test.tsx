// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SessionMetrics } from "./SessionMetrics";

describe("SessionMetrics", () => {
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

  it("shows the running clock while capturing, before anything is heard", () => {
    act(() => {
      root.render(
        <SessionMetrics conversation={null} liveStartedAt={Date.now()} />,
      );
    });
    expect(container.textContent).toMatch(/live · 0:0\d/);
  });

  it("shows no session line when there is no session", () => {
    act(() => {
      root.render(<SessionMetrics conversation={null} />);
    });
    expect(container.textContent).not.toContain("·");
  });
});
