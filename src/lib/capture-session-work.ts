/**
 * True when a capture start was cancelled by a stop that arrived while it was
 * still setting up. That is the user's own action, not a failure to report.
 * The text is `START_CANCELLED_ERROR` in the Rust capture commands.
 */
export function isStartCancelled(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("Capture stopped during startup");
}

export function createCaptureSessionWork() {
  let currentGeneration = 0;
  const pending = new Map<number, Set<Promise<unknown>>>();

  const api = {
    begin(): number {
      currentGeneration += 1;
      return currentGeneration;
    },
    isCurrent(generation: number): boolean {
      return generation === currentGeneration;
    },
    track<T>(generation: number, work: Promise<T>): Promise<T> {
      const jobs = pending.get(generation) ?? new Set<Promise<unknown>>();
      pending.set(generation, jobs);

      const tracked = work.finally(() => {
        jobs.delete(tracked);
        if (jobs.size === 0) {
          pending.delete(generation);
        }
      });
      jobs.add(tracked);
      return tracked;
    },
    async drain(generation: number, timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;

      while ((pending.get(generation)?.size ?? 0) > 0) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return false;

        const jobs = [...(pending.get(generation) ?? [])];
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const completed = await Promise.race([
          Promise.allSettled(jobs).then(() => true),
          new Promise<false>((resolve) => {
            timeoutId = setTimeout(() => resolve(false), remaining);
          }),
        ]);
        if (timeoutId) clearTimeout(timeoutId);
        if (!completed) return false;
      }

      return true;
    },
    invalidate(generation: number): void {
      if (generation === currentGeneration) {
        currentGeneration += 1;
      }
    },
    /**
     * Keep `generation` current until its pending work has settled (or
     * `timeoutMs` passes), then invalidate it. For work that outlives a stop:
     * its result should still land, but nothing new may join the session.
     */
    async invalidateWhenSettled(
      generation: number,
      timeoutMs: number,
    ): Promise<void> {
      await api.drain(generation, timeoutMs);
      api.invalidate(generation);
    },
  };
  return api;
}
