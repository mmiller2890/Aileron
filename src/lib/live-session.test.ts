import { describe, expect, test } from "vitest";
import {
  deriveBarNotice,
  deriveLiveAnswerDraft,
  LiveSessionSnapshot,
} from "./live-session";
import { ChatConversation } from "@/types/completion";

const emptyConversation: ChatConversation = {
  id: "test",
  messages: [],
} as unknown as ChatConversation;

const snapshot = (
  overrides: Partial<LiveSessionSnapshot>
): LiveSessionSnapshot => ({
  capturing: false,
  isContinuousMode: false,
  isRecordingInContinuousMode: false,
  isProcessing: false,
  isAIProcessing: false,
  error: "",
  setupRequired: false,
  isSttInitializing: false,
  lastAIResponse: "",
  conversation: emptyConversation,
  sessionStartedAt: null,
  currentSpeaker: null,
  isLabelingSpeakers: false,
  sessionSummary: "",
  isSummarizing: false,
  audioLevel: 0,
  noAudioDetected: false,
  ...overrides,
});

describe("deriveBarNotice", () => {
  test("returns null for a null snapshot", () => {
    expect(deriveBarNotice(null)).toBeNull();
  });

  test("returns null when there is no error and setup is not required", () => {
    expect(deriveBarNotice(snapshot({}))).toBeNull();
  });

  test("returns a setup notice when setup is required", () => {
    const notice = deriveBarNotice(snapshot({ setupRequired: true }));
    expect(notice?.kind).toBe("setup");
  });

  test("setup takes precedence over a generic error", () => {
    const notice = deriveBarNotice(
      snapshot({ setupRequired: true, error: "Permission not granted" })
    );
    expect(notice?.kind).toBe("setup");
  });

  test("returns an error notice carrying the error text when setup is not required", () => {
    const notice = deriveBarNotice(
      snapshot({ error: "No AI provider selected." })
    );
    expect(notice).toEqual({ kind: "error", message: "No AI provider selected." });
  });

  test("returns an init notice while STT models are initializing", () => {
    const notice = deriveBarNotice(snapshot({ isSttInitializing: true }));
    expect(notice?.kind).toBe("init");
  });

  test("setup takes precedence over STT initialization", () => {
    const notice = deriveBarNotice(
      snapshot({ setupRequired: true, isSttInitializing: true })
    );
    expect(notice?.kind).toBe("setup");
  });

  test("error takes precedence over STT initialization", () => {
    const notice = deriveBarNotice(
      snapshot({ error: "boom", isSttInitializing: true })
    );
    expect(notice?.kind).toBe("error");
  });
});

describe("deriveLiveAnswerDraft", () => {
  test("returns null without a live snapshot", () => {
    expect(deriveLiveAnswerDraft(null)).toBeNull();
  });

  test("returns an empty draft before the first streamed token", () => {
    expect(
      deriveLiveAnswerDraft(snapshot({ isAIProcessing: true }))
    ).toBe("");
  });

  test("returns the current streamed response while answering", () => {
    expect(
      deriveLiveAnswerDraft(
        snapshot({ isAIProcessing: true, lastAIResponse: "Live answer" })
      )
    ).toBe("Live answer");
  });

  test("hides the draft after the final answer is persisted", () => {
    expect(
      deriveLiveAnswerDraft(
        snapshot({ isAIProcessing: false, lastAIResponse: "Final answer" })
      )
    ).toBeNull();
  });
});
