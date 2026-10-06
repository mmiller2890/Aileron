import { describe, expect, it } from "vitest";
import {
  applySpeakerEvent,
  clearProvisionalThroughTurn,
  emptyLiveSpeakerState,
  registerTurnMessage,
} from "./live-speakers";

describe("live speaker bookkeeping", () => {
  it("shows the provisional speaker for the turn in progress", () => {
    const { state, label } = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    });
    expect(state.provisional).toEqual({ turn: 1, speaker: "Speaker 1" });
    expect(label).toBeNull();
  });

  it("ignores a provisional speaker from an older turn", () => {
    const first = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 2,
      speaker: "Speaker 2",
      final: false,
    }).state;
    const { state } = applySpeakerEvent(first, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    });
    expect(state.provisional).toEqual({ turn: 2, speaker: "Speaker 2" });
  });

  it("hands the label to a message registered after the final arrived", () => {
    const afterFinal = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: true,
    });
    expect(afterFinal.label).toBeNull();
    const registered = registerTurnMessage(afterFinal.state, 1, "m1");
    expect(registered.speaker).toBe("Speaker 1");
  });

  it("labels an existing message when the final arrives late", () => {
    const registered = registerTurnMessage(emptyLiveSpeakerState, 1, "m1");
    expect(registered.speaker).toBeNull();
    const { label } = applySpeakerEvent(registered.state, {
      turn: 1,
      speaker: "Speaker 2",
      final: true,
    });
    expect(label).toEqual({ messageId: "m1", speaker: "Speaker 2" });
  });

  it("leaves a message unlabelled when the turn had no clear speaker", () => {
    const registered = registerTurnMessage(emptyLiveSpeakerState, 1, "m1");
    const { label, state } = applySpeakerEvent(registered.state, {
      turn: 1,
      speaker: null,
      final: true,
    });
    expect(label).toBeNull();
    expect(registerTurnMessage(state, 1, "m1").speaker).toBeNull();
  });

  it("drops the provisional speaker when its turn's final arrives", () => {
    const provisional = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 1,
      speaker: "Speaker 1",
      final: false,
    }).state;
    const { state } = applySpeakerEvent(provisional, {
      turn: 1,
      speaker: "Speaker 1",
      final: true,
    });
    expect(state.provisional).toBeNull();
  });

  it("clears the provisional speaker with the provisional text", () => {
    const state = applySpeakerEvent(emptyLiveSpeakerState, {
      turn: 3,
      speaker: "Speaker 1",
      final: false,
    }).state;
    expect(clearProvisionalThroughTurn(state, 3).provisional).toBeNull();
    expect(clearProvisionalThroughTurn(state, 2).provisional).not.toBeNull();
    expect(clearProvisionalThroughTurn(state, null).provisional).toBeNull();
  });
});
