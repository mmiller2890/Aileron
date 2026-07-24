# Capture Lifecycle and Live Answer Implementation Plan

1. Add regression tests for graceful task completion, backend-first UI activation, and transient answer derivation.
2. Add a shared capture stop flag and a bounded graceful-join helper in Rust.
3. Move capture session publication behind successful VAD backend startup while retaining immediate manual armed mode.
4. Render the streamed answer as a dedicated transient assistant row in the dashboard.
5. Run focused tests and all four required project gates, then inspect the final diff.
