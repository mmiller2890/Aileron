import { useEffect, useRef } from "react";
import { emit, listen } from "@tauri-apps/api/event";
import { LIVE_SESSION_REQUEST, LIVE_SESSION_STATE } from "@/lib/live-session";

const MIN_EMIT_INTERVAL_MS = 100;

/**
 * Broadcasts a live snapshot to other windows under `eventName`. Leading+trailing
 * throttle: the first change in a quiet period emits immediately (state
 * transitions never feel latent), high-frequency streams coalesce to ≤10 Hz,
 * and a trailing flush guarantees the final state always lands. Also answers
 * LIVE_SESSION_REQUEST with an immediate re-emit for freshly mounted mirrors.
 */
export function useLiveStatePublisher<T>(
  snapshot: T,
  eventName: string = LIVE_SESSION_STATE,
) {
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;

  const lastEmitRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const emitNow = () => {
      lastEmitRef.current = Date.now();
      emit(eventName, snapshotRef.current).catch((e) =>
        console.error("Failed to publish live session state:", e)
      );
    };

    const elapsed = Date.now() - lastEmitRef.current;
    if (elapsed >= MIN_EMIT_INTERVAL_MS) {
      emitNow();
    } else if (!timerRef.current) {
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        emitNow();
      }, MIN_EMIT_INTERVAL_MS - elapsed);
    }
    // A scheduled trailing emit reads snapshotRef, so it always sends the
    // freshest state even when more changes landed while it was pending.
  }, [snapshot, eventName]);

  useEffect(() => {
    const unlisten = listen(LIVE_SESSION_REQUEST, () => {
      lastEmitRef.current = Date.now();
      emit(eventName, snapshotRef.current).catch((e) =>
        console.error("Failed to answer live session request:", e)
      );
    });
    return () => {
      unlisten.then((fn) => fn());
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [eventName]);
}
