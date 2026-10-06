import { describe, expect, it } from "vitest";
import { applyPartial, clearThroughTurn } from "./live-text";

describe("live text state", () => {
  it("shows the newest text for the turn in progress", () => {
    let state = applyPartial(null, { turn: 1, text: "could you" });
    state = applyPartial(state, { turn: 1, text: "could you walk me" });
    expect(state).toEqual({ turn: 1, text: "could you walk me" });
  });

  it("moves on to a newer turn and ignores a late partial from an older one", () => {
    let state = applyPartial(null, { turn: 2, text: "next question" });
    state = applyPartial(state, { turn: 1, text: "stale" });
    expect(state).toEqual({ turn: 2, text: "next question" });
  });

  it("ignores empty text", () => {
    const state = applyPartial({ turn: 1, text: "hello" }, { turn: 1, text: "  " });
    expect(state).toEqual({ turn: 1, text: "hello" });
  });

  it("clears when the final for that turn lands", () => {
    expect(clearThroughTurn({ turn: 3, text: "abc" }, 3)).toBeNull();
  });

  it("keeps a newer turn's text when an older turn's final lands", () => {
    const state = { turn: 4, text: "already talking again" };
    expect(clearThroughTurn(state, 3)).toBe(state);
  });

  it("clears unconditionally when no turn is given", () => {
    expect(clearThroughTurn({ turn: 4, text: "abc" }, null)).toBeNull();
    expect(clearThroughTurn({ turn: 4, text: "abc" }, undefined)).toBeNull();
  });
});
