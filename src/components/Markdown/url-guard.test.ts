import { describe, expect, test } from "vitest";
import { isSafeExternalUrl } from "./url-guard";

describe("isSafeExternalUrl", () => {
  test("allows https URLs", () => {
    expect(isSafeExternalUrl("https://example.com/path?q=1")).toBe(true);
  });

  test("allows http URLs", () => {
    expect(isSafeExternalUrl("http://localhost:1420")).toBe(true);
  });

  test("allows mailto links", () => {
    expect(isSafeExternalUrl("mailto:help@example.com")).toBe(true);
  });

  test("blocks file:// URLs", () => {
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
  });

  test("blocks smb:// URLs", () => {
    expect(isSafeExternalUrl("smb://server/share")).toBe(false);
  });

  test("blocks javascript: URLs", () => {
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
  });

  test("blocks data: URLs", () => {
    expect(isSafeExternalUrl("data:text/html,<script>alert(1)</script>")).toBe(
      false
    );
  });

  test("blocks relative URLs", () => {
    expect(isSafeExternalUrl("/relative/path")).toBe(false);
  });

  test("blocks invalid URLs", () => {
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });
});
