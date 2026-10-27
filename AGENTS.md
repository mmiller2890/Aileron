# AGENTS.md

## Project Overview

Assistant is a local-only fork of an open-source Pluely project — a Tauri 2 + React desktop app that provides a stealth AI assistant overlay for meetings, interviews, and conversations. This fork removes all cloud features (hosted API, license activation, auto-updater, telemetry) and defaults to local providers (Ollama for AI; fluidaudio-rs on macOS, or a local speech server on Linux/Windows).

Both platforms are first-class. The **Linux** build is what runs on the interview machine (Nobara 44, KDE Plasma, Wayland, RTX 3080) and gets the Fedora `.rpm`; it uses a local NeMo server for transcription, live text and speaker labels. macOS keeps the same model family in-process through FluidAudio.

## Tech Stack

- **Frontend:** React 19, TypeScript 5.8, Tailwind CSS 4, Vite 7
- **Desktop:** Tauri 2 (Rust backend)
- **Local AI:** Ollama (`localhost:11434`)
- **Local STT:** fluidaudio-rs in-process CoreML ASR on macOS Apple Silicon (default); on Linux/Windows either `parakeet_server.py` (NeMo Parakeet TDT v3 on CUDA, `localhost:8001`) or `whisper_server.py` (faster-whisper, `localhost:8000`)
- **Voice activity:** Silero — through FluidAudio on macOS, through `silero-vad-crs` (a C port with embedded weights) elsewhere, with a loudness threshold only as a fallback
- **Language:** TypeScript (frontend), Rust (backend), Python (whisper server only)

### Live text and speaker labels

- macOS: FluidAudio's streaming ASR and Sortformer, in-process.
- Linux/Windows: the same model family through `parakeet_server.py` over loopback — `src-tauri/src/speaker/remote_live_text.rs` re-transcribes the turn in progress for live text, `remote_live_speakers.rs` asks the server for per-slot activity from a persistent Sortformer streaming state. Both are previews: the final transcript comes from `fetchSTT`.
- With any other provider (cloud, or Local Whisper) the two switches are disabled on Linux; they say why.

## Commands

### Install

```bash
npm install
npm run setup        # Preflight: checks Node 18+, Rust, Swift 6+/Xcode 16 (macOS), Ollama. SKIP_ENV_CHECK=1 to bypass.
```

### Development

```bash
npm run tauri dev      # Full app (Rust + frontend)
npm run dev            # Frontend only (Vite, port 1420)
```

### Build

```bash
npm run build          # Frontend production build
npm run tauri build    # Full app bundle
```

### Testing

```bash
npm test               # Run vitest once (config: vitest.config.ts; tests: src/**/*.test.ts)
npm run test:watch     # Watch mode
```

### Typecheck & Lint

```bash
npx tsc --noEmit       # TypeScript typecheck (must pass before committing)
cargo check --manifest-path src-tauri/Cargo.toml  # Rust check
```

No linter is configured. Run `npx tsc --noEmit` and `npm run build` to verify changes compile.

### Prerequisites

- **macOS:** Xcode 16 + Swift 6+ required (fluidaudio-rs builds a Swift package during the Rust build).
- Optional: Ollama for local AI. Any cloud/curl AI provider works without it.
- `npm run setup` (auto-run before `npm run tauri ...` via the `pretauri` hook) verifies these.

## Project Structure

```
src/
  components/         # Shared React components (UI primitives, Sidebar, etc.)
  config/             # Constants: AI_PROVIDERS, STT providers, storage keys, shortcuts
  contexts/           # React context (app state: providers, license, settings)
  hooks/              # Custom hooks (useApp, useSettings, useCompletion, useSystemAudio)
  layouts/            # Page layouts (DashboardLayout, PageLayout, ErrorLayout)
  lib/                # Core logic: AI/STT functions, storage, analytics, database
  pages/              # Route pages (app, dashboard, chats, settings, dev, etc.)
  routes/             # React Router config
  types/              # TypeScript type definitions
src-tauri/
  src/                # Rust source (window mgmt, capture, shortcuts, speaker, STT)
  capabilities/        # Tauri permissions (HTTP scopes, plugin permissions)
  tauri.conf.json     # Tauri config (productName, windows, updater, plugins)
  Cargo.toml          # Rust dependencies (includes fluidaudio-rs on macOS)
```

## Key Architectural Notes

### Provider System

- AI and STT providers are defined as curl templates in `src/config/` (constants files).
- Variables like `{{API_KEY}}`, `{{MODEL}}`, `{{AUDIO}}` are extracted and replaced at runtime.
- The `extractVariables()` function in `src/lib/functions/common.function.ts` parses curl templates.
- Provider config is stored in localStorage and managed via `src/contexts/app.context.tsx`.

### Cloud Features (Removed)

- `hasActiveLicense` in context always returns `true` (all features unlocked).
- `localApiEnabled` defaults to `false` (a `useState` in `app.context.tsx`); it stays inert in this fork but is still read by completion/STT gating, so don't assume it's a hardcoded constant.
- Analytics (`src/lib/analytics.ts`) are no-ops.
- Auto-updater is disabled (empty endpoint in `tauri.conf.json`).
- These stubs are kept for compile compatibility — do not re-enable them.

### HTTP Fetch

- `tauriFetch` (Tauri HTTP plugin) is used for `http://` URLs (local providers) to bypass CORS.
- Browser `fetch` is used only for `https://` URLs.
- See `src/lib/functions/stt.function.ts` and `ai-response.function.ts` line: `url?.startsWith("https") ? fetch : tauriFetch`.

### Local STT

- **macOS (default):** `local-fluidaudio` uses fluidaudio-rs in-process CoreML ASR on macOS 14+ Apple Silicon. No Python server required. The pipeline is: VAD detects speech → Rust emits `speech-detected` with a base64 WAV → frontend `fetchSTT()` invokes `stt_transcribe_speech` → Rust returns final text.
- **Linux/Windows:** `local-parakeet` uses `parakeet_server.py` (NeMo Parakeet TDT v3 on CUDA) on `localhost:8001` and is what live text and speaker labels run through; `local-whisper` uses faster-whisper via `whisper_server.py` on `localhost:8000` and gives final transcripts only. Neither server is packaged — the app checks both at startup, picks Parakeet when Whisper is not running, and says what to start when a capture begins with the server down.
- **Linux specifics:** PulseAudio/PipeWire capture from the sink's monitor source, GTK window sizing workaround, opaque windows (`tauri.linux.conf.json`), `WEBKIT_DISABLE_DMABUF_RENDERER=1` when an NVIDIA driver is loaded. Global shortcuts go through X11 grabs, which KDE and GNOME honour under Wayland via XWayland. **Screen-share hiding does not exist on Linux** (`contentProtected` is a no-op in tao) — do not claim it.
- `whisper_server.py` exposes `POST /v1/audio/transcriptions` (OpenAI-compatible).
- Tauri capabilities in `src-tauri/capabilities/` whitelist `localhost:8000` for the whisper server.

## Conventions

- No comments in code unless explicitly requested.
- Follow existing code style (Tailwind classes, component patterns).
- All UI text uses "Aileron" as the product name.
- Run `npx tsc --noEmit` and `npm run build` after any change to verify it compiles.
- Do not commit secrets, API keys, or tokens.
