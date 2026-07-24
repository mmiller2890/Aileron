# Capture Lifecycle and Live Answer Design

## Scope

Implement review findings 1, 3, and 5 without changing manual capture semantics or launching the application.

## Design

System-audio capture receives a shared atomic stop signal owned by `AudioState`. Both VAD and continuous capture loops observe it. The stop command signals the task, waits up to five seconds for its normal cleanup path, and aborts only after that deadline. This preserves trailing speech emission and the session WAV used by diarization.

Frontend capture startup becomes a two-phase operation. VAD mode stops any stale backend task and starts the new task before publishing the new session as active. Manual mode has no backend task until recording begins, so it publishes its existing armed state immediately.

The dashboard derives a transient answer draft from `LiveSessionSnapshot`. It renders the draft as its own assistant row while `isAIProcessing` is true, including before the first token. Once processing finishes, the draft disappears and the persisted assistant message remains, preventing duplicate final answers.

## Verification

Add focused Rust and Vitest regressions, then run TypeScript typechecking, the production frontend build, all Vitest tests, and `cargo check`.
