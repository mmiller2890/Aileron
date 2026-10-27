// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { applyLinuxOpaqueBackground } from "./linux-background";

describe("applyLinuxOpaqueBackground", () => {
  beforeEach(() => {
    // index.html ships the body transparent, inline and !important.
    document.body.setAttribute("style", "background-color: transparent !important");
  });

  it("paints Linux app windows in the theme background", () => {
    expect(applyLinuxOpaqueBackground(document.body, "linux", "main")).toBe(true);
    expect(document.body.style.getPropertyValue("background-color")).toBe("var(--background)");
    expect(document.body.style.getPropertyPriority("background-color")).toBe("important");
  });

  it("leaves macOS and Windows transparent", () => {
    expect(applyLinuxOpaqueBackground(document.body, "macos", "main")).toBe(false);
    expect(applyLinuxOpaqueBackground(document.body, "windows", "main")).toBe(false);
    expect(document.body.style.getPropertyValue("background-color")).toBe("transparent");
  });

  it("leaves the screenshot overlays see-through", () => {
    expect(applyLinuxOpaqueBackground(document.body, "linux", "capture-overlay-0")).toBe(false);
    expect(document.body.style.getPropertyValue("background-color")).toBe("transparent");
  });
});
