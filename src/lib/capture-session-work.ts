export type SessionAudioStopAction = "none" | "diarize" | "discard";

export function getSessionAudioStopAction(
  provider: string,
  sessionPath: string | null,
  sttDrained: boolean
): SessionAudioStopAction {
  if (!sessionPath) return "none";
  if (provider === "local-fluidaudio" && sttDrained) return "diarize";
  return "discard";
}

export function createCaptureSessionWork() {
  let currentGeneration = 0;
  const pending = new Map<number, Set<Promise<unknown>>>();

  return {
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
  };
}
