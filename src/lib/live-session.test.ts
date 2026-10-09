import { describe, expect, test } from "vitest";
import {
  buildLiveChatSnapshot,
  deriveBarNotice,
  deriveChatStatus,
  deriveDashboardSource,
  deriveDashboardView,
  deriveLiveAnswerDraft,
  greetingForHour,
  LiveChatSnapshot,
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

const chatInput = (
  overrides: Partial<Parameters<typeof buildLiveChatSnapshot>[0]>,
): Parameters<typeof buildLiveChatSnapshot>[0] => ({
  conversationId: null,
  history: [],
  input: "",
  response: "",
  isLoading: false,
  error: null,
  listening: false,
  now: 1000,
  ...overrides,
});

const savedPair = [
  { id: "u1", role: "user" as const, content: "What is Chef?", timestamp: 10 },
  {
    id: "a1",
    role: "assistant" as const,
    content: "A configuration tool.",
    timestamp: 11,
  },
];

describe("buildLiveChatSnapshot", () => {
  test("is empty and idle before anything is asked", () => {
    const chat = buildLiveChatSnapshot(chatInput({}));
    expect(chat.conversation.messages).toEqual([]);
    expect(chat.answering).toBe(false);
    expect(chat.listening).toBe(false);
  });

  test("shows the question and the streaming answer while one is in flight", () => {
    const chat = buildLiveChatSnapshot(
      chatInput({
        history: savedPair,
        input: "What are CI/CD pipelines?",
        response: "They are",
        isLoading: true,
      }),
    );
    expect(chat.conversation.messages.map((m) => m.content)).toEqual([
      "What is Chef?",
      "A configuration tool.",
      "What are CI/CD pipelines?",
    ]);
    expect(chat.answering).toBe(true);
    expect(chat.answerDraft).toBe("They are");
    // The pending question sorts after everything already saved.
    expect(chat.conversation.messages[2].timestamp).toBeGreaterThan(11);
  });

  test("keeps a finished answer on screen until its save lands", () => {
    const chat = buildLiveChatSnapshot(
      chatInput({
        history: savedPair,
        input: "What are CI/CD pipelines?",
        response: "Automated build and deploy steps.",
      }),
    );
    expect(chat.answering).toBe(false);
    expect(chat.conversation.messages.map((m) => m.content)).toEqual([
      "What is Chef?",
      "A configuration tool.",
      "What are CI/CD pipelines?",
      "Automated build and deploy steps.",
    ]);
  });

  test("does not repeat an answer that is already saved", () => {
    const chat = buildLiveChatSnapshot(
      chatInput({ history: savedPair, response: "A configuration tool." }),
    );
    expect(chat.conversation.messages).toHaveLength(2);
  });

  test("carries the conversation id, listening state and error", () => {
    const chat = buildLiveChatSnapshot(
      chatInput({ conversationId: "conv_1", listening: true, error: "boom" }),
    );
    expect(chat.conversation.id).toBe("conv_1");
    expect(chat.listening).toBe(true);
    expect(chat.error).toBe("boom");
  });
});

const chat = (overrides: Partial<LiveChatSnapshot>): LiveChatSnapshot => ({
  listening: false,
  answering: false,
  answerDraft: "",
  error: "",
  conversation: emptyConversation,
  ...overrides,
});

const conversationAt = (updatedAt: number): ChatConversation =>
  ({
    id: "c",
    messages: [{ id: "m1", role: "user", content: "hi", timestamp: updatedAt }],
    updatedAt,
  }) as unknown as ChatConversation;

describe("deriveDashboardSource", () => {
  test("is home when neither the capture session nor the bar has anything", () => {
    expect(deriveDashboardSource(null, null)).toBe("home");
    expect(deriveDashboardSource(snapshot({}), chat({}))).toBe("home");
  });

  test("shows the bar's conversation once voice input is on or it has messages", () => {
    expect(deriveDashboardSource(null, chat({ listening: true }))).toBe("chat");
    expect(deriveDashboardSource(snapshot({}), chat({ answering: true }))).toBe(
      "chat",
    );
    expect(
      deriveDashboardSource(snapshot({}), chat({ conversation: conversationAt(5) })),
    ).toBe("chat");
  });

  test("shows the capture session when that is what is running", () => {
    expect(
      deriveDashboardSource(
        snapshot({ capturing: true }),
        chat({ conversation: conversationAt(5) }),
      ),
    ).toBe("engine");
  });

  test("an active bar conversation is not hidden by a finished capture session", () => {
    expect(
      deriveDashboardSource(
        snapshot({ conversation: conversationAt(5) }),
        chat({ listening: true }),
      ),
    ).toBe("chat");
  });

  test("with both idle, shows whichever conversation changed last", () => {
    expect(
      deriveDashboardSource(
        snapshot({ conversation: conversationAt(5) }),
        chat({ conversation: conversationAt(9) }),
      ),
    ).toBe("chat");
    expect(
      deriveDashboardSource(
        snapshot({ conversation: conversationAt(9) }),
        chat({ conversation: conversationAt(5) }),
      ),
    ).toBe("engine");
  });
});

describe("deriveChatStatus", () => {
  test("ranks error over answering over listening", () => {
    expect(deriveChatStatus(null).word).toBe("idle");
    expect(deriveChatStatus(chat({ listening: true })).word).toBe("listening");
    expect(
      deriveChatStatus(chat({ listening: true, answering: true })).word,
    ).toBe("answering");
    expect(
      deriveChatStatus(chat({ answering: true, error: "boom" })).word,
    ).toBe("error");
  });
});
