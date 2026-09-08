// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  fetchAIResponse: vi.fn(),
  saveConversation: vi.fn(),
  getConversationById: vi.fn(),
}));

vi.mock("@/contexts", () => ({
  useApp: () => ({
    selectedAIProvider: { provider: "p1" },
    allAiProviders: [{ id: "p1" }],
    systemPrompt: "",
    screenshotConfiguration: { enabled: false, mode: "auto", autoPrompt: "" },
    setScreenshotConfiguration: vi.fn(),
    selectedSttProvider: { provider: "" },
    localApiEnabled: false,
  }),
}));

vi.mock("@/hooks", () => ({
  useGlobalShortcuts: () => ({
    registerAudioCallback: () => () => undefined,
    registerInputRef: () => () => undefined,
    registerScreenshotCallback: () => () => undefined,
  }),
}));

vi.mock("./useWindow", () => ({
  useWindowResize: () => ({ resizeWindow: vi.fn() }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(""),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
}));

vi.mock("@/lib/functions", () => ({
  buildAIHistory: (history: unknown) => history,
}));

vi.mock("@/lib/attachments", () => ({
  appendWithinLimit: (list: unknown[], add: unknown[]) => [...list, ...add],
  selectImageFilesWithinLimit: (files: unknown[]) => files,
}));

vi.mock("@/lib", async () => {
  const tokenBatcher = await import("@/lib/token-batcher");
  let requestCounter = 0;
  let idCounter = 0;
  return {
    MESSAGE_ID_OFFSET: 1000,
    isMacOS: () => false,
    getResponseSettings: () => ({ autoScroll: false }),
    generateRequestId: () => `req-${++requestCounter}`,
    generateConversationId: (prefix: string) => `${prefix}-${++idCounter}`,
    generateMessageId: (role: string, timestamp: number) =>
      `${role}-${timestamp}`,
    generateConversationTitle: (message: string) => message.trim(),
    fetchAIResponse: mocks.fetchAIResponse,
    saveConversation: mocks.saveConversation,
    getConversationById: mocks.getConversationById,
    createTokenBatcher: tokenBatcher.createTokenBatcher,
  };
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type Stream = {
  signals: AbortSignal[];
  emit: (chunk: string) => void;
  end: () => void;
};

function createStream(): Stream {
  const gates: Deferred<IteratorResult<string>>[] = [];
  const signals: AbortSignal[] = [];

  mocks.fetchAIResponse.mockImplementation((options: {
    signal: AbortSignal;
  }) => {
    signals.push(options.signal);
    return (async function* generate() {
      for (;;) {
        const gate = deferred<IteratorResult<string>>();
        gates.push(gate);
        const result = await gate.promise;
        if (result.done) return;
        yield result.value;
      }
    })();
  });

  return {
    signals,
    emit(chunk: string) {
      const gate = gates.shift();
      if (!gate) return;
      gate.resolve({ value: chunk, done: false });
    },
    end() {
      const gate = gates.shift();
      if (!gate) return;
      gate.resolve({ value: undefined, done: true });
    },
  };
}

type Completion = ReturnType<typeof import("./useCompletion").useCompletion>;

let latest: Completion | null = null;

async function mountHook() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const { useCompletion } = await import("./useCompletion");
  function Probe() {
    latest = useCompletion();
    return null;
  }

  await act(async () => {
    root.render(<Probe />);
  });
  return () => {
    act(() => {
      root.unmount();
    });
  };
}

async function settle(rounds = 12) {
  await act(async () => {
    for (let index = 0; index < rounds; index++) {
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  });
}

beforeEach(() => {
  mocks.fetchAIResponse.mockReset();
  mocks.saveConversation
    .mockReset()
    .mockReturnValue(new Promise(() => undefined));
  mocks.getConversationById.mockReset().mockResolvedValue(null);
  latest = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useCompletion conversation isolation", () => {
  it("new chat aborts the prior stream and keeps the new conversation empty", async () => {
    const unmount = await mountHook();
    const stream = createStream();

    await act(async () => {
      latest!.submit("hello");
    });
    expect(stream.signals).toHaveLength(1);

    await act(async () => {
      stream.emit("A");
    });
    await settle();
    expect(latest!.response).toBe("A");

    await act(async () => {
      latest!.startNewConversation();
    });

    await act(async () => {
      stream.emit("B");
    });
    await settle();
    await act(async () => {
      stream.end();
    });
    await settle();

    expect(stream.signals[0].aborted).toBe(true);
    expect(latest!.response).toBe("");
    expect(latest!.conversationHistory).toEqual([]);
    require("node:fs").appendFileSync("/tmp/uc-debug.log", JSON.stringify({id: latest!.currentConversationId, h: latest!.conversationHistory.length, e: latest!.error}) + "\n");
    expect(latest!.currentConversationId).toBeNull();
    expect(latest!.error).toBeNull();
    expect(mocks.saveConversation).not.toHaveBeenCalled();

    unmount();
  });

  it("selecting a different conversation isolates it from the prior stream", async () => {
    const unmount = await mountHook();
    const stream = createStream();

    await act(async () => {
      latest!.submit("hello");
    });
    await act(async () => {
      stream.emit("A");
    });

    await act(async () => {
      latest!.loadConversation({
        id: "other",
        title: "Other",
        messages: [
          { id: "om1", role: "user", content: "earlier", timestamp: 1 },
        ],
        createdAt: 1,
        updatedAt: 2,
      });
    });

    await act(async () => {
      stream.emit("B");
    });
    await act(async () => {
      stream.end();
    });
    await settle();

    expect(stream.signals[0].aborted).toBe(true);
    expect(latest!.currentConversationId).toBe("other");
    expect(latest!.conversationHistory).toEqual([
      { id: "om1", role: "user", content: "earlier", timestamp: 1 },
    ]);
    expect(latest!.error).toBeNull();
    expect(mocks.saveConversation).not.toHaveBeenCalled();

    unmount();
  });

  it("delayed save success after switching does not change the new conversation", async () => {
    const unmount = await mountHook();
    const stream = createStream();

    const saved = deferred<void>();
    mocks.saveConversation.mockImplementationOnce(() => saved.promise);

    await act(async () => {
      latest!.submit("hello");
    });
    await act(async () => {
      stream.emit("A");
    });
    await act(async () => {
      stream.end();
    });
    await settle();
    expect(mocks.saveConversation).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest!.startNewConversation();
    });

    await act(async () => {
      saved.resolve();
    });
    await settle();

    expect(latest!.currentConversationId).toBeNull();
    expect(latest!.conversationHistory).toEqual([]);
    expect(latest!.isLoading).toBe(false);
    expect(latest!.error).toBeNull();

    unmount();
  });

  it("delayed save rejection after switching does not change the new conversation", async () => {
    const unmount = await mountHook();
    const stream = createStream();

    const saved = deferred<void>();
    mocks.saveConversation.mockImplementationOnce(() => saved.promise);

    await act(async () => {
      latest!.submit("hello");
    });
    await act(async () => {
      stream.emit("A");
    });
    await act(async () => {
      stream.end();
    });
    await settle();
    expect(mocks.saveConversation).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest!.startNewConversation();
    });

    await act(async () => {
      saved.reject(new Error("disk I/O error"));
    });
    await settle();

    expect(latest!.currentConversationId).toBeNull();
    expect(latest!.conversationHistory).toEqual([]);
    expect(latest!.isLoading).toBe(false);
    expect(latest!.error).toBeNull();

    unmount();
  });

  it("user-initiated stop keeps already accepted content", async () => {
    const unmount = await mountHook();
    const stream = createStream();

    await act(async () => {
      latest!.submit("hello");
    });
    await act(async () => {
      stream.emit("A");
    });
    await settle();
    expect(latest!.response).toBe("A");

    await act(async () => {
      latest!.cancel();
    });

    expect(stream.signals[0].aborted).toBe(true);
    expect(latest!.response).toBe("A");
    expect(latest!.isLoading).toBe(false);

    await act(async () => {
      stream.end();
    });
    await settle();

    expect(latest!.response).toBe("A");
    expect(mocks.saveConversation).not.toHaveBeenCalled();

    unmount();
  });
});