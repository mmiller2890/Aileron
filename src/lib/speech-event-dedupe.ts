export interface SpeechEventPayload {
  /**
   * Base64 WAV. Null when the utterance is cached in Rust: the local model
   * claims it by `utterance_id`, and remote providers fetch the WAV by id.
   */
  audio: string | null;
  start_time: number;
  end_time: number;
  /**
   * Handle for the same utterance's samples, still held by the Rust capture
   * loop. Absent if the cache couldn't be written; callers must cope.
   */
  utterance_id?: string | null;
  /** Turn number within the capture; matches `speech-partial` events. */
  turn?: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 32;

const hashAudio = (audio: string): string => {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < audio.length; index += 1) {
    const value = audio.charCodeAt(index);
    first = Math.imul(first ^ value, 0x01000193);
    second = Math.imul(second ^ value, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
};

// Cache ids are unique per utterance, so they fingerprint it outright.
const fingerprint = (payload: SpeechEventPayload): string =>
  payload.utterance_id
    ? `id:${payload.utterance_id}`
    : `${payload.start_time}:${payload.end_time}:${payload.audio?.length ?? 0}:${hashAudio(
        payload.audio ?? ""
      )}`;

export class RecentSpeechEventFingerprints {
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_TTL_MS,
    private readonly maxEntries = DEFAULT_MAX_ENTRIES
  ) {}

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  claim(payload: SpeechEventPayload, now = Date.now()): boolean {
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) {
        this.entries.delete(key);
      }
    }

    const key = fingerprint(payload);
    if (this.entries.has(key)) {
      return false;
    }

    this.entries.set(key, now + this.ttlMs);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return true;
  }
}
