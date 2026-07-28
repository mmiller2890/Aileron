# Live Session Readiness Design

## Goal

Make Aileron's primary live workflow reliable on macOS: system-audio capture with local Fluidaudio transcription and either a cloud AI provider or a loopback local AI provider.

## Constraints

- Do not launch Aileron or compete with the user's port 1420 development instance.
- Keep the existing macOS 14 minimum and local-first architecture.
- Avoid additional Fluidaudio instances because the target machine has 8 GB of memory.
- Preserve the original-rate WAV used by remote STT providers, fallback decoding, and post-session diarization.
- Keep every implementation change covered by a regression test and separately reversible.

## Design

### Local transcription sample rate

System audio may arrive at device rates such as 48 kHz, while Fluidaudio's sample transcription API requires 16 kHz mono input. Before an utterance enters the Rust `UtteranceStore`, create a 16 kHz copy with the existing linear resampler. Cache only that transcription copy. Continue encoding the original-rate samples into the emitted WAV so remote providers and audio metadata remain correct.

The cache API will make its input contract explicit so a future caller cannot accidentally store device-rate samples as ASR-ready samples. Tests will prove that a 48 kHz utterance becomes the expected 16 kHz frame count and that 16 kHz input remains unchanged.

### Capture continuity while ASR runs

ASR and Silero VAD currently share the `SttInner` mutex. A transcription can hold it longer than the approximately 2.7 seconds buffered by the macOS CoreAudio ring, causing capture drops or termination while the next question is spoken.

VAD access will use a non-blocking mutex acquisition. When Fluidaudio is busy, the VAD call will report temporary unavailability and the existing RMS/peak fallback will classify that chunk. ASR remains serialized, but capture never waits for it. This avoids a second Fluidaudio engine and its memory cost.

### Session-bound transcription

Each capture start receives a monotonically increasing session generation. Every speech event captures that generation before starting STT and checks it again before changing transcripts, errors, conversation history, or AI state. A result from a stopped or superseded session is discarded.

Pending STT work is tracked separately from AI response work. The speech listener awaits transcription and records the utterance, then starts question answering without keeping the STT job open for the entire AI stream. Stop waits for the current session's already-emitted trailing transcription before diarization and summary, with a bounded timeout; after that boundary it invalidates the generation. This prevents old transcripts from entering a new session and allows the final utterance to appear in the ended session's summary.

### Shortcut listener ownership

`useGlobalShortcuts` is mounted by both completion and system-audio hooks, and React StrictMode mounts effects twice. Its asynchronous setup can therefore register several listener sets before the module-level handles are assigned.

Listener initialization will be guarded by a shared single-flight initializer. Concurrent callers receive the same setup promise, so registration runs once per webview. Callback refs remain replaceable, allowing each hook to publish its latest callback without re-registering native listeners. If setup fails, the initializer becomes retryable rather than permanently caching failure.

### Provider authentication boundary

An empty API key will be allowed only when the fully resolved request URL has a loopback host: `localhost`, `127.0.0.0/8`, or `::1`. Provider IDs will not bypass authentication. This keeps stock and custom loopback Ollama/LM Studio configurations keyless while ensuring remote and cloud endpoints fail before a request is sent without credentials.

### Provider switching and secret migration

Capture and transcription remain independent of the selected AI provider. A provider change affects the next utterance; an already-started response keeps its captured provider configuration. No capture restart is required when switching between cloud and local AI.

Provider switches will announce their final hydrated value through the authoritative Tauri cross-window event, including providers with no stored secret. The persistence effect remains suppressed during hydration so it cannot overwrite a stored secret with an interim empty object.

The unscoped legacy secret is eligible for migration only while loading the provider ID already persisted at application startup. An arbitrary provider switch reads only that provider's scoped secret, preventing provider A's legacy credentials from being copied under provider B. Deleting a custom provider also deletes its scoped secret.

### Streaming failure integrity

If an AI stream fails after returning partial tokens, the partial text remains visible as transient UI feedback but is not committed to conversation history. The error path exits before constructing the persisted assistant message.

The local utterance fast path distinguishes a missing or expired cache entry from an ASR failure. Only a typed cache miss invokes the WAV decode fallback; model, initialization, or inference failures are returned directly so the same failing inference is not immediately repeated.

### Model warmup lifecycle

Ollama warmup requests explicitly set `stream: false` and consume the small response body before completing. This prevents periodic heartbeat requests from leaving response streams open while preserving the existing best-effort behavior.

## Error Handling

- If VAD cannot acquire Fluidaudio immediately, use the existing threshold fallback for that chunk without surfacing an error.
- If pending STT does not drain within its bounded stop timeout, invalidate the session and discard any later result rather than blocking shutdown indefinitely.
- Invalid or unresolved provider URLs do not receive the local-key exemption.
- Shortcut setup errors continue to be logged and can be retried on a later mount.
- Only an explicit utterance-cache-miss code triggers local WAV fallback.
- Failed AI streams do not persist partial assistant messages.
- Existing user-facing STT and provider errors remain unchanged.

## Testing

Implementation follows red-green testing:

1. Add a Rust regression test proving device-rate utterances are normalized to 16 kHz before caching.
2. Add a Rust regression test proving busy Fluidaudio access does not wait on the mutex.
3. Add a TypeScript test proving concurrent shortcut initializers execute registration once and retry after failure.
4. Update provider-auth tests so built-in IDs do not exempt non-loopback URLs.
5. Add session-work tests proving stopped-session results are rejected and stop drains registered STT jobs without waiting for AI.
6. Add provider synchronization tests for switch announcements, no-secret switches, and one-time legacy migration.
7. Add tests proving partial AI streams are not persisted and only typed cache misses use WAV fallback.
8. Add a warmup test proving non-streaming mode and body consumption.
9. Run `git diff --check`, `npx tsc --noEmit`, `npx vitest run`, `npm run build`, `cargo test`, and `cargo check`.
10. Run a complete `npm run tauri build` without launching the application.

## Acceptance Criteria

- Cached system-audio samples passed to local Fluidaudio are always 16 kHz mono.
- Capture-time VAD never blocks behind an active transcription.
- A stopped session cannot append transcripts or answers to a later session.
- Stop includes a completed trailing transcription in diarization/summary input when it finishes within the bounded drain period.
- One native shortcut event invokes one registered JavaScript listener path.
- Empty API keys are accepted only for resolved loopback endpoints.
- Provider switches synchronize after hydration without copying legacy credentials across providers.
- Failed streams and failed local inference do not persist or repeat partial work.
- Warmup heartbeats leave no streaming response body open.
- All required gates and the full Tauri bundle build pass.
- The final handoff identifies manual checks that cannot be automated: macOS permissions, real device audio level, transcription quality, provider credentials, shortcut conflicts, and overlay visibility.
