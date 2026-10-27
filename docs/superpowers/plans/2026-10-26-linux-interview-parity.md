# Linux Interview Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Linux build of Aileron as dependable as the macOS build for a live interview on the user's Nobara 44 / KDE Plasma (Wayland) / RTX 3080 PC, without changing macOS behaviour.

**Architecture:** Both platforms stay first-class. macOS keeps FluidAudio (CoreML Parakeet, Silero, Sortformer) in-process. Linux uses the same model family through a local NeMo server (`parakeet_server.py`, systemd user service `aileron-parakeet`, port 8001) plus in-process Silero (`silero-vad-crs`). This plan closes the gaps that could break an interview first (Phase A), then reaches feature parity (Phase B), then cleans up and ships (Phase C).

**Tech Stack:** Tauri 2.8 (Rust + React/TypeScript, vitest), WebKitGTK 4.1, PulseAudio/PipeWire, NeMo 3.0 + PyTorch 2.14 cu130 (Python 3.12 venv at `~/.local/share/aileron-asr`), Fedora 44 `.rpm` built in a container.

**Spec:** this conversation's findings, summarised in "Context" below. Supporting docs: `docs/plans/2026-09-28-audio-overflow-remediation.md` (capture history), the two external reviews pasted on 2026-10-26 (findings verified against the code; Tier 2 "delete macOS" is rejected because macOS stays a target).

## Context (what already exists — do not rebuild)

- `dev` at `64d6b5e`, 7 commits ahead of `origin/dev`. Linux commits: `4dc6d97` capture queue/skip/stopper, `08e4c67` Silero off macOS, `908d77f` NVIDIA Wayland launch fix, `22c1e66` opaque overlay, `11b0d2d` page background, `1b2abcc` GTK resize, `a9e3e48` Parakeet server + provider, `64d6b5e` live text off macOS.
- Live text off macOS: `src-tauri/src/speaker/remote_live_text.rs` (`RemoteLiveTextModel`, `is_local_endpoint`), frontend `src/lib/live-text-endpoint.ts` (`liveTextEndpointFor`), passed as `liveTextUrl` to `start_system_audio_capture`.
- Measured on the RTX 3080: Parakeet 7.1 s speech → 53 ms, 30.8 s → 122 ms; live-text requests p50 71 ms, max 232 ms.
- The 2026-10-26 "Could not reach http://localhost:8000" incident: the user had not selected Local Parakeet; Linux defaults to Local Whisper, which nobody runs. Two Aileron processes were also running at once.

## Global Constraints

- All work lands on `dev`; never push to GitHub without the user saying so; `main` is frozen.
- macOS behaviour must not change unless a task says so. Gate platform code with `#[cfg(...)]` / `getPlatform()`.
- Before every commit, all must pass on the Mac: `npx tsc --noEmit`, `npm run build`, `npx vitest run`, `cd src-tauri && cargo check && cargo test --lib`.
- Linux-only Rust must also be compiled and tested on Linux: the Omarchy laptop (`ssh -o BatchMode=yes neptune@100.90.106.29`, login shell is fish — pipe scripts through `bash -s`), working tree `~/aileron-linux` (sync with `git bundle` → `git fetch` + `git reset --hard`, it is a scratch tree). Run `cargo test --locked --lib` there.
- Build the Fedora package only with `scripts/build-fedora-rpm.sh` (Fedora 44 container; Arch's glibc is too new). Verify with a clean `fedora:44` container `dnf install` and `ldd`.
- Test on the PC: `ssh -o BatchMode=yes neptune@nep-pc` (key `~/.ssh/id_ed25519_nep_pc`). `sudo` needs the user's password — never use it; ask the user to run `sudo dnf reinstall ~/Downloads/Aileron-<ver>.x86_64.rpm`. Launch GUI tests with the session env (`XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 XAUTHORITY=/run/user/1000/xauth_* DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus`). Window geometry: a KWin script via `qdbus org.kde.KWin /Scripting` printing `workspace.windowList()` geometry, read from `journalctl --user`.
- Never `pkill -f <pattern>` over SSH with a plain pattern (it kills the SSH shell); use `pkill -x Aileron` or `[A]ileron`-style patterns.
- Do not touch the user's uncommitted dashboard work on the Mac: `src/lib/live-session.ts`, `src/lib/live-session.test.ts`, `src/pages/dashboard/index.tsx`, `src/pages/dashboard/components/EmbeddedBar.tsx`, `src/pages/dashboard/components/EmbeddedBar.test.tsx`.
- Do not start a second `tauri dev` on the Mac (port 1420 collides with the user's).
- Commit messages state only what was verified, and on which platform ("verified on Linux"; never claim Windows unless it was compiled).
- Logs go to `~/.local/share/com.assistant.local/logs/aileron.log` on Linux; read them before theorising.

## Review Focus

1. Parakeet server still loading at login (`/health` returns `"status":"loading"` for ~20 s) — auto-select must still choose Parakeet, and starting capture must say "starting" rather than "not running". Test in Task 2.
2. The user deliberately chose Local Whisper and runs `whisper_server.py` — auto-select must not override a provider whose server is up. Test in Task 2.
3. A second launch while capturing must only bring the app forward; it must not stop or restart capture. Manual check in Task 1.
4. The Parakeet server stops mid-session — live text stops with the existing `live-feature-stopped` notice, and the next final transcript shows the actionable "server isn't running" message, not a raw request error. Test in Task 2 (message) and Task 5 (final path).
5. A Mac whose saved provider is the removed, older `local-parakeet` (MLX server) — after platform filtering it must migrate to `local-fluidaudio`, never post to `:8001`. Test in Task 6.

---

## Phase A — could break an interview

### Task 1: One Aileron process on Linux

**Files:**
- Modify: `src-tauri/Cargo.toml` (Linux target dependencies)
- Modify: `src-tauri/src/lib.rs:52-80` (builder)

**Interfaces:**
- Produces: nothing new for other tasks.

- [ ] **Step 1: Add `tauri-plugin-single-instance = "2"` under `[target.'cfg(target_os = "linux")'.dependencies]`.** macOS (LaunchServices) and Windows are out of scope; do not add it for them.
- [ ] **Step 2: Register it as the first plugin in `run()`, Linux only.** The callback brings the existing app forward and does nothing else: call `crate::window::show_dashboard_window(app)` and, if the main window (`app.get_webview_window("main")`) is hidden, leave it hidden — the user's overlay visibility is theirs. Log `tracing::info!("Second launch: brought the running Aileron forward")`.
- [ ] **Step 3: Verify on the PC.** Install the rebuilt rpm (user runs `sudo dnf reinstall`). Launch Aileron from the KDE launcher twice, then over SSH: `pgrep -c -x Aileron` → `1`. Start listening, launch again: capture continues (the log has no `capture stop requested` line after the second launch).
- [ ] **Step 4: Commit** — `fix: run a single Aileron process on Linux`.

### Task 2: Choose and check the local speech server on Linux

**Files:**
- Create: `src/lib/local-stt-server.ts`, `src/lib/local-stt-server.test.ts`
- Modify: `src/contexts/app.context.tsx:575-612` (startup provider gating), `src/hooks/useSystemAudio.ts` (start of `startCapture`, near the `local-fluidaudio` branch at ~line 1136)

**Interfaces:**
- Produces:
  - `type LocalServerState = "up" | "loading" | "down"`
  - `localServerHealthUrl(providerId: string): string | null` — `"http://localhost:8001/health"` for `local-parakeet`, `"http://localhost:8000/health"` for `local-whisper`, else `null`. Derive host/port from the provider's built-in curl in `SPEECH_TO_TEXT_PROVIDERS`.
  - `checkLocalServer(url: string, fetchFn: typeof fetch, timeoutMs = 1500): Promise<LocalServerState>` — `"up"` for JSON `status === "ok"`, `"loading"` for `status === "loading"`, `"down"` on non-2xx, timeout or network error.
  - `pickLinuxProvider(saved: string, parakeet: LocalServerState, whisper: LocalServerState): string | null` — returns `"local-parakeet"` when `saved` is `""` or `"local-whisper"`, `whisper === "down"`, and `parakeet !== "down"`; otherwise `null` (keep the saved choice).
  - `localServerDownMessage(providerId: string, state: LocalServerState): string | null` — exact copy:
    - parakeet down: `Parakeet speech server isn't running. Start it with: systemctl --user start aileron-parakeet`
    - parakeet loading: `Parakeet speech server is still starting (loading the model). Try again in a few seconds.`
    - whisper down: `Local Whisper isn't running on port 8000. Start whisper_server.py, or choose Local Parakeet in speech settings.`
    - otherwise `null`.

- [ ] **Step 1: Write the failing tests** in `src/lib/local-stt-server.test.ts`:
  - `localServerHealthUrl("local-parakeet")` → `"http://localhost:8001/health"`; `("local-whisper")` → `":8000/health"` URL; `("openai-whisper")` → `null`.
  - `checkLocalServer` with a fake fetch returning `{"status":"ok"}` → `"up"`; `{"status":"loading"}` → `"loading"`; a rejecting fetch → `"down"`; a fetch that never resolves → `"down"` within the timeout (use fake timers).
  - `pickLinuxProvider("local-whisper", "loading", "down")` → `"local-parakeet"` (Review Focus 1); `("local-whisper", "up", "up")` → `null` (Review Focus 2); `("openai-whisper", "up", "down")` → `null`; `("", "up", "down")` → `"local-parakeet"`; `("local-whisper", "down", "down")` → `null`.
  - `localServerDownMessage` returns each exact string above.
- [ ] **Step 2: Run** `npx vitest run src/lib/local-stt-server.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement the module.** Use `@tauri-apps/plugin-http` `fetch` at call sites (loopback is already allowed in `src-tauri/capabilities/*.json`); the functions take `fetchFn` so tests inject one.
- [ ] **Step 4: Wire startup** — in the non-macOS branch of `initializeApp` (`app.context.tsx`), after the existing `shouldFallbackSttProvider` check: check both servers, and if `pickLinuxProvider` returns an id, call `onSetSelectedSttProvider({ provider: "local-parakeet", variables: {} })`.
- [ ] **Step 5: Wire capture start** — in `startCapture` (`useSystemAudio.ts`), off macOS and for `local-parakeet` / `local-whisper` only: check the server; if `localServerDownMessage` is non-null, `setError(message)` and return without starting capture.
- [ ] **Step 6: Run** the full vitest suite and `tsc` — PASS.
- [ ] **Step 7: Verify on the PC** — with the service running, set the saved provider to Local Whisper, restart Aileron: provider becomes Local Parakeet. `systemctl --user stop aileron-parakeet`, start listening: the parakeet "isn't running" message shows and the log has no `capture started` line. Restart the service afterwards.
- [ ] **Step 8: Commit** — `fix: pick and check the local speech server on Linux`.

### Task 3: Global shortcuts on KDE Wayland

**Files (only if Step 2 fails):**
- Create: `src-tauri/src/linux_shortcuts.rs`
- Modify: `src-tauri/Cargo.toml` (Linux deps), `src-tauri/src/lib.rs` (global-shortcut setup ~line 169), `src-tauri/src/shortcuts.rs` (`update_shortcuts`)

**Interfaces:**
- Consumes: `shortcuts::handle_shortcut_action<R>(app: &AppHandle<R>, action_id: &str)`.
- Produces (if built): `linux_shortcuts::register_portal_shortcuts(app: &AppHandle, bindings: &[(String /*action_id*/, String /*accelerator*/)]) -> Result<(), String>`.

- [ ] **Step 1: Measure first.** `tauri-plugin-global-shortcut` uses `global-hotkey 0.7`, which has macOS, Windows and X11 backends only — on Wayland it relies on XWayland. On the PC, focus a native Wayland window (Konsole), press the system-audio capture shortcut, and check `aileron.log` for `System-audio capture started`. Repeat with Firefox/Brave focused, and with the Aileron dashboard focused. Record which work.
- [ ] **Step 2: Decide.** If the shortcut works with native Wayland apps focused, stop here: add a README note listing the verified combination (KDE Plasma 6.7, Wayland, XWayland) and commit `docs: record verified Linux shortcut support`. If it fails, continue.
- [ ] **Step 3: Implement the XDG GlobalShortcuts portal** (`org.freedesktop.portal.GlobalShortcuts`, supported by KDE) with the `ashpd` crate, Linux only, used when `WAYLAND_DISPLAY` is set; keep the existing X11 path otherwise. Each portal `Activated` signal calls `handle_shortcut_action` with the action id. Accelerators come from the same bindings `update_shortcuts` receives; KDE may ask the user once to confirm.
- [ ] **Step 4: Verify on the PC** with Konsole focused: the capture shortcut starts and stops listening.
- [ ] **Step 5: Commit** — `feat: global shortcuts through the portal on Wayland (verified on KDE)`.

---

## Phase B — parity with macOS

### Task 4: Speaker labels on Linux through the Parakeet server

**Files:**
- Modify: `parakeet_server.py` (new endpoints)
- Create: `src-tauri/src/speaker/remote_live_speakers.rs`
- Modify: `src-tauri/src/speaker/mod.rs`, `src-tauri/src/speaker/commands.rs` (`start_system_audio_capture`, the `#[cfg(not(target_os = "macos"))] let live_speakers` site), `src/lib/live-text-endpoint.ts`, `src/hooks/useSystemAudio.ts` (the three start calls that pass `liveTextUrl`)

**Interfaces:**
- Consumes: `live_speakers::LiveSpeakerModel` (`reset`, `feed(&[f32]) -> Result<SlotCounts, String>`, `end_turn() -> Result<SlotCounts, String>`), `SlotCounts = [u32; 4]` counting active 80 ms frames per speaker slot in the open turn; `remote_live_text::is_local_endpoint`.
- Produces:
  - Server: `POST /v1/speakers/reset` → `{}`; `POST /v1/speakers/feed` (multipart `file` = 16 kHz mono WAV chunk) → `{"counts":[n0,n1,n2,n3]}` for the open turn; `POST /v1/speakers/end_turn` → final `{"counts":[...]}` and opens a new turn. One session (one capture at a time); speaker slots persist across turns until `reset`.
  - Rust: `RemoteLiveSpeakerModel::new(base_url: String) -> Result<Self, String>` implementing `LiveSpeakerModel`.
  - Frontend: `liveSpeakersEndpointFor(providerId, platform): string | null` (base `http://localhost:8001/v1/speakers` for `local-parakeet` off macOS), passed as `liveSpeakersUrl` to `start_system_audio_capture(…, live_speakers_url: Option<String>)`.

- [ ] **Step 1: Research the model API before coding.** Load `nvidia/diar_streaming_sortformer_4spk-v2` (the streaming Sortformer FluidAudio uses on macOS) in NeMo 3.0 in the PC's venv and find its streaming inference entry point and frame rate (expect 80 ms frames). Write findings as a comment at the top of the new server section. If NeMo 3.0 has no streaming step API, stop and report to the user before choosing an alternative — speaker identity must stay stable across turns, which a per-turn re-diarisation cannot guarantee.
- [ ] **Step 2: Write the failing Rust tests** in `remote_live_speakers.rs`, reusing the fake TCP server pattern from `remote_live_text.rs` tests (move it to a shared `#[cfg(test)]` helper module if both need it): `feed` returns the server's `counts`; `end_turn` posts to `/end_turn`; `reset` posts to `/reset`; a non-local base URL is rejected; an unreachable server is an `Err`.
- [ ] **Step 3: Run on Linux** — FAIL (module missing).
- [ ] **Step 4: Implement** `RemoteLiveSpeakerModel` (reqwest, `no_proxy`, 5 s timeout, requests inside `tauri::async_runtime::block_on`, 16 kHz WAV as in `remote_live_text.rs`) and the server endpoints (share the GPU `model_lock`).
- [ ] **Step 5: Wire** capture start (spawn `LiveSpeakerHandle` with the remote model when `vad_config.live_speakers` and the URL is local) and the frontend parameter.
- [ ] **Step 6: Verify end to end on the PC** with a two-voice clip made on the Mac (`say -v Samantha` / `say -v Daniel` alternating sentences, 48 kHz WAV): played through the PC speakers while listening, alternating turns get alternating labels and each voice keeps its label across at least four turns.
- [ ] **Step 7: Commit** — `feat: speaker labels off macOS from the local Parakeet server (verified on Linux)`.

### Task 5: Final transcripts straight from Rust on Linux

The Linux final path today: Rust base64-encodes a capture-rate WAV into the `speech-detected` event, the UI decodes it, and `@tauri-apps/plugin-http` re-sends it as a JSON array of bytes (`Array.from(new Uint8Array(buffer))`) — about 0.1–0.3 s per long turn.

**Files:**
- Modify: `src-tauri/src/speaker/commands.rs` (`emit_speech_detected`: cache utterances off macOS too), `src-tauri/src/stt.rs` (new command), `src-tauri/src/lib.rs` (register), `src/lib/functions/stt.function.ts` (`fetchSTT`)

**Interfaces:**
- Consumes: `UtteranceStore::put_capture` / `take`, `remote_live_text::is_local_endpoint`, `resample::StreamingResampler`.
- Produces: Tauri command `stt_transcribe_via_local_server(utterance_id: String, endpoint: String) -> Result<String, String>` — takes the cached utterance, resamples to 16 kHz, posts a 16 kHz WAV, returns the trimmed `text`. Errors prefixed `UTTERANCE_CACHE_MISS:` on a cache miss (same prefix as `stt_transcribe_utterance`).

- [ ] **Step 1: Write the failing Rust test** (Linux): with the fake server, a cached 48 kHz utterance posts a WAV whose header says 16,000 Hz and the command returns the server's text; a non-local endpoint is rejected; a missing id returns the `UTTERANCE_CACHE_MISS:` error.
- [ ] **Step 2: Write the failing vitest** in `stt.function.test.ts`: for `local-parakeet` with an `utteranceId`, `fetchSTT` invokes `stt_transcribe_via_local_server` and never calls `tauriFetch`; on a cache-miss error it falls back to the existing upload path.
- [ ] **Step 3: Implement**; off macOS, `emit_speech_detected` stores the processed capture-rate samples in `UtteranceStore` and sends `utterance_id` with the payload (keep `audio` inline off macOS so other remote providers keep working).
- [ ] **Step 4: Measure on the PC**: time from the turn's last word to the final transcript, before and after, on the 30.8 s clip; report both numbers in the commit.
- [ ] **Step 5: Commit** — `perf: send Linux final transcripts to the local server from Rust (verified on Linux)`.

### Task 6: Review fixes that affect correctness or safety

**Files:**
- Modify: `src-tauri/src/speaker/remote_live_text.rs` (`is_local_endpoint`)
- Modify: `src-tauri/src/speaker/commands.rs` (live-text audio when portable VAD is unavailable)
- Modify: `src-tauri/src/speaker/linux.rs`, `src-tauri/src/speaker/mod.rs` (`output_device_connected` on Linux)
- Modify: `src/contexts/app.context.tsx:857-860` (`allSttProviders`), `src/config/stt.constants.ts`, `src/types/provider.type.ts`

**Interfaces:**
- Produces: `provider_visible_on(platform: "macos" | "windows" | "linux", providerPlatform?: string): boolean` in `src/lib/provider-platform.ts` — `"macos-apple-silicon"` → macOS only; `"windows-linux"` → Windows and Linux; undefined → everywhere.

- [ ] **Step 1: Endpoint guard.** Failing tests: `is_local_endpoint("http://127.0.0.1:8001@evil.com/x")` → `false`; `("http://localhost:8001/v1/x")` → `true`; `("https://localhost:8001/x")` → `false` (http only). Implement by parsing with `reqwest::Url` and requiring scheme `http` and `host_str()` ∈ {`127.0.0.1`, `localhost`, `[::1]`/`::1`}.
- [ ] **Step 2: Live text without Silero.** Failing Linux test (extract the decision into a function the test can call): when the portable VAD is `None`, the hop is still resampled to 16 kHz for live text. Implement by giving the capture loop its own `StreamingResampler` for live text when `portable_vad` is `None` (do not resample twice when Silero is running — reuse `portable_vad_hop`'s output).
- [ ] **Step 3: Stale output device on Linux.** Failing test for a pure `device_listed(uid: &str, devices: &[AudioDevice]) -> bool`; make Linux `output_device_connected` call `linux::get_output_devices()` and use it. This lets `resolve_output_device` fall back to the default monitor instead of failing to open `<stale>.monitor`.
- [ ] **Step 4: Provider platforms.** Failing tests for `provider_visible_on`, plus Review Focus 5: a context test (or pure function test) that a saved `"local-parakeet"` on macOS is treated as unavailable and migrates through the existing removed-provider path to the macOS default `local-fluidaudio`. Filter `allSttProviders` with it. Update the stale comment at `app.context.tsx:863` (it names `local-parakeet` as removed).
- [ ] **Step 5: Run all gates on the Mac and `cargo test --locked --lib` on Linux.**
- [ ] **Step 6: Commit** — `fix: harden the local-endpoint guard and Linux provider and device handling`.

### Task 7: Truthful Linux settings and docs

**Files:**
- Modify: `src/pages/app/components/speech/SettingsPanel.tsx:187-232` ("While listening" section)
- Modify: `README.md` (lines 7, 9, 29, 35, 150-160), `AGENTS.md`

- [ ] **Step 1: Failing component tests** (vitest + jsdom, like `EmbeddedBar.test.tsx`): off macOS with a provider other than `local-parakeet`, the Live text and Speaker labels rows show `Needs Local Parakeet (NVIDIA GPU) on Linux` and their switches are disabled; with `local-parakeet` they are enabled (Speaker labels only once Task 4 is done — until then, hidden off macOS); on Linux the panel shows the stealth note below.
- [ ] **Step 2: Implement.** Stealth note, exact copy: `Screen-share hiding isn't available on Linux. If you share your screen, share a single window or browser tab, not the whole screen.`
- [ ] **Step 3: Docs.** README: state screen-share hiding is macOS/Windows only (lines 7, 29, 35 and the hero alt text on line 9); replace the stale `mlx_asr_server.py` / old `local-parakeet` section (lines ~150-160) with Linux setup: rpm install, `parakeet_server.py` venv steps, the `aileron-parakeet` user service, selecting Local Parakeet. AGENTS.md: describe both platforms (macOS: FluidAudio; Linux: Silero via `silero-vad-crs`, Parakeet server, live text/speakers over loopback, Fedora rpm build, laptop/PC testing).
- [ ] **Step 4: Commit** — `docs: describe the Linux build truthfully in settings and docs`.

---

## Phase C — finish and ship

### Task 8: Small cleanups from the reviews

**Files:** `src-tauri/src/window.rs`, `src-tauri/src/speaker/mod.rs`, `parakeet_server.py`, `src-tauri/src/speaker/live_text.rs`

- [ ] **Step 1:** Call `prepare_linux_resize` once from `setup_main_window` instead of on every `set_window_height`; verify on the PC the bar still idles at 600×64 and grows/shrinks (KWin geometry script).
- [ ] **Step 2:** In `create_dashboard_window`, off macOS, set `.background_color(tauri::window::Color(13, 19, 16, 255))` (`#0d1310`, the theme `--background`) so the dashboard never flashes white.
- [ ] **Step 3:** Fix comments: `speaker/mod.rs` doc comment on `output_device_connected` (it absorbed `default_output_uid`'s doc) and the `backlog_samples` doc ("Only macOS buffers capture this way" — Linux has since `4dc6d97`); `parakeet_server.py` upload-cap comment (Starlette spools uploads before the handler; the cap bounds what is read, and loopback-only binding is the real protection); a comment at `LIVE_TEXT_QUEUE_MESSAGES` that one slow remote request can overflow the ~2 s queue and drop live-text audio until the next turn.
- [ ] **Step 4:** In `src-tauri/src/linux_compat.rs`, add a comment recording why the NVIDIA trigger is deliberately broad (a missed trigger means the app does not open; an extra one only disables DMA-BUF for a small UI; `WEBKIT_DISABLE_DMABUF_RENDERER` set by the user is respected). Do not narrow it.
- [ ] **Step 5: Gates, commit** — `chore: tidy Linux comments and window setup`.

### Task 9: Version, packages, push

- [ ] **Step 1:** Bump the version to `0.2.0` in `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` (so `dnf install`/upgrade works without `reinstall`).
- [ ] **Step 2:** Build the Fedora rpm with `scripts/build-fedora-rpm.sh`; verify in a clean `fedora:44` container (dnf install OK, `ldd` no missing libraries, max GLIBC ≤ 2.39); copy to the PC's `~/Downloads` and to the Mac's `dist-fedora/`; compare SHA-256.
- [ ] **Step 3:** Build the macOS release from committed code only: `git worktree add --detach <scratch>/release HEAD`, symlink the repo's `node_modules` into it, run `npx tauri build` there, then copy `src-tauri/target/release/bundle/{macos,dmg}` into the repo's own `src-tauri/target/release/bundle/` with `ditto` (keeps the signature) and `git worktree remove --force` the scratch copy. Verify `codesign --verify --deep --strict` on the app and on the app inside the DMG. Ad-hoc signing (`signingIdentity: "-"`) means macOS asks for permissions again after each build; tell the user.
- [ ] **Step 4:** Ask the user before pushing `dev`; push only on their yes.

## Out of scope

- Hiding the overlay from screen capture on Linux (no Wayland/X11 mechanism exists).
- Deleting macOS or Windows code paths.
- A stable macOS signing certificate (needs the user to create it in Keychain).
- Incremental conversation saves and idle auto-stop (separate proposals).
