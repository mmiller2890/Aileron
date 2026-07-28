/**
 * Interval between flushes, in ms.
 *
 * ~25 updates/second: fast enough that text still reads as streaming, slow
 * enough to decouple render count from token rate.
 */
export const TOKEN_FLUSH_INTERVAL_MS = 40;

export interface TokenBatcher {
  /** Queue a chunk; it lands on the next flush. */
  push(chunk: string): void;
  /** Flush immediately. Call when the stream ends or is cancelled. */
  flush(): void;
  /** Drop anything buffered without emitting it, and stop the timer. */
  cancel(): void;
}

/**
 * Coalesce streamed tokens into at most one update per flush interval.
 *
 * Rendering an in-flight response re-runs the whole markdown + syntax
 * highlighting pipeline over the entire accumulated string, so a state update
 * per token means dozens of full re-parses a second — which is what makes a
 * fast stream feel choppy.
 *
 * Deliberately timer-based rather than `requestAnimationFrame`: the assistant
 * overlay is frequently hidden, and rAF callbacks don't run for a hidden
 * window, which would stall a response until it was brought back into view.
 */
export function createTokenBatcher(
  onFlush: (chunk: string) => void,
  intervalMs: number = TOKEN_FLUSH_INTERVAL_MS,
  isActive: () => boolean = () => true
): TokenBatcher {
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let cancelled = false;

  const emit = () => {
    timer = null;
    if (!pending) return;
    const chunk = pending;
    pending = "";
    if (cancelled || !isActive()) return;
    onFlush(chunk);
  };

  return {
    push(chunk: string) {
      if (!chunk || cancelled || !isActive()) return;
      pending += chunk;
      if (timer === null) {
        timer = setTimeout(emit, intervalMs);
      }
    },
    flush() {
      if (cancelled) return;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      cancelled = true;
      pending = "";
    },
  };
}
