/**
 * Linux app windows are opaque (see `src-tauri/tauri.linux.conf.json`):
 * transparent windows render unreliably in WebKitGTK with the NVIDIA driver.
 * `index.html` keeps the page transparent for macOS, and WebKitGTK paints a
 * transparent page in an opaque window white, so any area the content does
 * not cover (the overlay sized for an open panel) showed as a white box.
 * Paint it in the theme background instead. Screenshot overlays stay
 * see-through.
 */
export function applyLinuxOpaqueBackground(
  body: HTMLElement,
  platform: "macos" | "windows" | "linux",
  windowLabel: string,
): boolean {
  if (platform !== "linux" || windowLabel.startsWith("capture-overlay-")) {
    return false;
  }
  // The inline transparent rule is !important, so only an inline !important
  // rule overrides it.
  body.style.setProperty("background-color", "var(--background)", "important");
  return true;
}
