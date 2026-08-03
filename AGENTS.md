# AGENTS.md

## Project Overview
Assistant is a local-only fork of an open-source Pluely project — a Tauri 2 + React desktop app that provides a stealth AI assistant overlay for meetings, interviews, and conversations. This fork removes all cloud features (hosted API, license activation, auto-updater, telemetry) and defaults to local providers (Ollama for AI, fluidaudio-rs for STT on macOS, faster-whisper on Windows/Linux).

## Tech Stack
- **Frontend:** React 19, TypeScript 5.8, Tailwind CSS 4, Vite 7
- **Desktop:** Tauri 2 (Rust backend)
- **Local AI:** Ollama (`localhost:11434`)
- **Local STT:** fluidaudio-rs in-process CoreML ASR on macOS Apple Silicon (default), faster-whisper with Whisper Large v3 Turbo on Windows/Linux (via `whisper_server.py` on `localhost:8000`)
- **Language:** TypeScript (frontend), Rust (backend), Python (whisper server only)

### Known local STT limitation
- `local-fluidaudio` (fluidaudio-rs) uses a batch transcription path. VAD captures the utterance as a WAV, then `fetchSTT()` calls the Rust `stt_transcribe_speech` command to get the final text. It does **not** expose live partial transcriptions.

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
- **Windows/Linux (default):** `local-whisper` uses faster-whisper with Whisper Large v3 Turbo via `whisper_server.py` on `localhost:8000`. Requires Python venv setup (`.whisper-venv`).
- `whisper_server.py` exposes `POST /v1/audio/transcriptions` (OpenAI-compatible).
- Tauri capabilities in `src-tauri/capabilities/` whitelist `localhost:8000` for the whisper server.

## Conventions
- No comments in code unless explicitly requested.
- Follow existing code style (Tailwind classes, component patterns).
- All UI text uses "Assistant" as the product name.
- Run `npx tsc --noEmit` and `npm run build` after any change to verify it compiles.
- Do not commit secrets, API keys, or tokens.