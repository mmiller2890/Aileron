import { describe, expect, it } from "vitest";
import base from "../../src-tauri/tauri.conf.json";
import linux from "../../src-tauri/tauri.linux.conf.json";

// Tauri merges tauri.linux.conf.json over tauri.conf.json on Linux, and a
// merge replaces arrays whole: the Linux file restates the overlay window.
// Only the transparency may differ (transparent windows render invisibly
// under WebKitGTK with the NVIDIA driver), or Linux silently drifts.
describe("Linux window config", () => {
  it("restates the overlay window with only its transparency changed", () => {
    const [baseWindow] = base.app.windows;
    const [linuxWindow] = linux.app.windows;
    const { transparent, backgroundColor, ...linuxRest } = linuxWindow;
    const { transparent: baseTransparent, ...baseRest } = baseWindow;

    expect(baseTransparent).toBe(true);
    expect(transparent).toBe(false);
    expect(backgroundColor).toMatch(/^#[0-9a-f]{6}$/i);
    expect(linuxRest).toEqual(baseRest);
    expect(linux.app.windows).toHaveLength(base.app.windows.length);
  });
});
