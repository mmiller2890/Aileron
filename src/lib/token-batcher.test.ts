import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createTokenBatcher, TOKEN_FLUSH_INTERVAL_MS } from "./token-batcher";

describe("createTokenBatcher", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces chunks pushed within one interval into a single flush", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);

    batcher.push("a");
    batcher.push("b");
    batcher.push("c");
    expect(onFlush).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("abc");
  });

  it("emits across successive intervals without losing or repeating text", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);

    batcher.push("one");
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS);
    batcher.push("two");
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS);

    expect(onFlush.mock.calls.map((c) => c[0])).toEqual(["one", "two"]);
  });

  it("does not fire when nothing was pushed", () => {
    const onFlush = vi.fn();
    createTokenBatcher(onFlush);
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS * 5);
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("flush() emits buffered text immediately", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);

    batcher.push("tail");
    batcher.flush();
    expect(onFlush).toHaveBeenCalledWith("tail");

    // The pending timer must not fire a second, empty flush.
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS * 2);
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("flush() is a no-op when nothing is buffered", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);
    batcher.flush();
    expect(onFlush).not.toHaveBeenCalled();
  });

  it("cancel() drops buffered text without emitting it", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);

    batcher.push("discarded");
    batcher.cancel();
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS * 2);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("stays cancelled when a late chunk arrives", () => {
    const onFlush = vi.fn();
    const batcher = createTokenBatcher(onFlush);

    batcher.push("dropped");
    batcher.cancel();
    batcher.push("late");
    batcher.flush();
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS);

    expect(onFlush).not.toHaveBeenCalled();
  });

  it("drops buffered text when the request becomes inactive", () => {
    const onFlush = vi.fn();
    let active = true;
    const batcher = createTokenBatcher(
      onFlush,
      TOKEN_FLUSH_INTERVAL_MS,
      () => active
    );

    batcher.push("stale");
    active = false;
    batcher.flush();
    vi.advanceTimersByTime(TOKEN_FLUSH_INTERVAL_MS);

    expect(onFlush).not.toHaveBeenCalled();
  });
});
