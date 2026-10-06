import { describe, expect, test } from "vitest";
import {
  deriveBarNotice,
  deriveDashboardView,
  deriveLiveAnswerDraft,
  greetingForHour,
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
  partialTranscription: "",
  partialSpeaker: null,
  conversation: emptyConversation,
  sessionStartedAt: null,
  currentSpeaker: null,
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

describe("deriveDashboardView", () => {
  test("is home when nothing is running and there is nothing to show", () => {
    expect(deriveDashboardView(null)).toBe("home");
    expect(deriveDashboardView(snapshot({}))).toBe("home");
    // A setup or error notice belongs on the home screen, not a blank feed.
    expect(deriveDashboardView(snapshot({ setupRequired: true }))).toBe("home");
    expect(deriveDashboardView(snapshot({ error: "boom" }))).toBe("home");
  });

  test("is the session view while capturing, even before anything is heard", () => {
    expect(deriveDashboardView(snapshot({ capturing: true }))).toBe("session");
  });

  test("stays on the session after capture stops, until it is cleared", () => {
    const withMessages = {
      ...emptyConversation,
      messages: [{ id: "m1", role: "user", content: "hi", timestamp: 1 }],
    } as unknown as ChatConversation;
    expect(
      deriveDashboardView(snapshot({ conversation: withMessages })),
    ).toBe("session");
  });

  test("is the session view while a typed question is being answered", () => {
    expect(deriveDashboardView(snapshot({ isAIProcessing: true }))).toBe(
      "session",
    );
    expect(deriveDashboardView(snapshot({ isProcessing: true }))).toBe(
      "session",
    );
  });
});

describe("greetingForHour", () => {
  test("follows the time of day", () => {
    expect(greetingForHour(5)).toBe("Good morning");
    expect(greetingForHour(11)).toBe("Good morning");
    expect(greetingForHour(12)).toBe("Good afternoon");
    expect(greetingForHour(17)).toBe("Good afternoon");
    expect(greetingForHour(18)).toBe("Good evening");
    expect(greetingForHour(23)).toBe("Good evening");
    expect(greetingForHour(2)).toBe("Good evening");
  });
});
