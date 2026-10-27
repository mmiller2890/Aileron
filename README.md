<div align="center">

# 🎙️ Aileron

**A private, on-device AI copilot for your meetings, interviews, and calls.**

It listens to a conversation, transcribes it locally, and quietly answers questions the moment they're asked — from a translucent overlay that stays out of the way, and on macOS and Windows off your screen shares too.

<img src="images/app-hero.svg" alt="Aileron — the session dashboard with live transcript and answers, and the pop-out bar above it" width="820" />

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24C8DB)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![Privacy](https://img.shields.io/badge/telemetry-none-brightgreen)

</div>

---

Aileron is a **local-only fork** of the excellent open-source [Pluely](https://github.com/iamsrikanthnani/pluely) project, stripped down for privacy: the hosted cloud API, license activation, auto-updater, and every trace of telemetry are gone. Nothing phones home. It talks **directly** to whatever AI and speech providers *you* configure — a local Ollama model, a cloud API you already pay for, or anything you can describe with a `curl` command.

## 💡 What it's for

- **Interviews & live Q&A** — hear a question, get a well-formed answer to reference, without fumbling.
- **Meetings** — a running transcript with speaker labels, plus on-demand answers when someone asks something you need help with.
- **Accessibility & note-taking** — live local captioning of system audio and your own voice, with searchable history.
- **Research & study** — screenshot a diagram or paste a prompt and ask a vision-capable model about it.

On macOS and Windows the overlay is **invisible to screen recording and screen sharing**, so it stays personal to you. **Linux has no such mechanism** — nothing on Wayland or X11 can exclude one window from a capture. If you share your screen on Linux, share a single window or browser tab rather than the whole screen.

## ✨ Features

| | |
|---|---|
| 🫥 **Stealth overlay** | Translucent, always-on-top window, hidden from screen shares and recordings on macOS and Windows. Linux has no way to exclude a window from a capture, so share a window, not the screen. |
| 🧠 **Bring your own AI** | Ollama out of the box, one-click presets for the major APIs, or **any provider at all via a `curl` command**. Full streaming support. |
| 🎧 **On-device speech-to-text** | Default **FluidAudio** engine runs in-process on Apple Silicon — no server, no Python, nothing to install. |
| ❓ **Smart answering** | Every utterance is transcribed, but only *questions* trigger an automatic answer. Anything skipped is one hotkey away (`⌘⇧⏎`). |
| 👥 **Speaker diarization** | Labels who said what in the transcript when a session ends. |
| 🔢 **Clean transcripts** | Inverse text normalization turns *"two hundred fifty dollars"* into *"$250"* before the AI ever sees it. |
| 🎚️ **Auto + manual capture** | Let voice detection segment speech automatically, or press record for a deliberate take. |
| 📸 **Screenshot analysis** | Send a screen grab to any vision-capable model. |
| 🎭 **System prompts** | Create and switch between AI personas for different tasks. |
| 🔒 **Zero telemetry** | No analytics, no tracking, no middleman. Your data goes to your provider and nowhere else. |

## 🚀 Quick Start

> **Fedora package:** `scripts/build-fedora-rpm.sh` builds `Aileron-<version>.x86_64.rpm` in a Fedora 44 container (a binary built on Arch links a newer glibc and will not start on Fedora). Install it with `sudo dnf install ./Aileron-*.x86_64.rpm`. The package contains no speech server: install one of the local servers below, or point Aileron at a cloud provider.
>
> **macOS:** built from source (a signed installer is [on the roadmap](docs/shipping-plan.md)). `npm run setup` checks the toolchain and tells you exactly what's missing.

**Prerequisites**

| Tool | Notes |
|---|---|
| [Node.js](https://nodejs.org/) 18+ | Frontend and tooling |
| [Rust](https://rustup.rs) (stable) | Auto-installed from `rust-toolchain.toml` on the first build |
| [Tauri 2 system deps](https://tauri.app/start/prerequisites/) | Platform build tools / webview libraries |
| **Xcode 16** *(macOS only)* | The local speech engine compiles a **Swift 6** package during the build — older toolchains fail with a confusing error |

For the zero-setup local speech engine you'll want **macOS 14+ on Apple Silicon**; everything else runs fine with a cloud or self-hosted STT provider.

```bash
git clone https://github.com/mmiller2890/Assistant-.git
cd Assistant-
npm install
npm run setup          # verify your toolchain (Node, Rust, Xcode/Swift, …)
npm run tauri dev      # develop — the first build takes a few minutes
npm run tauri build    # produce a native app
```

`npm run setup` also runs automatically before every `tauri` command, so a missing tool is caught up front with a clear fix instead of a cryptic failure deep in the build. On first launch, open the dashboard with **`⌘⇧D`** (`Ctrl+Shift+D` on Windows/Linux) and connect an AI provider — the only required step.

## 🧠 Connect an AI

Aileron doesn't lock you into a vendor. Pick whichever path fits.

### The easy path — Ollama (100% local, free)

```bash
ollama pull llama3.2   # or any model you like
ollama serve
```

The app auto-detects your installed Ollama models. Just choose one under **Dashboard → Dev Space → AI Providers**. No API key, no account.

### One-click presets

Built-in templates ship for **OpenAI, Claude, Gemini, Grok, Groq, Mistral, Cohere, Perplexity, OpenRouter, and LM Studio**. Select the provider, paste your API key, set the model name, and you're live.

> 💡 **LM Studio:** start its local server on port `1234`, pick the `lm-studio` provider, set `MODEL` to the loaded model's id — `API_KEY` can be left blank (local providers no longer require one).

### The power path — *any* AI via `curl`

If a service speaks HTTP, Aileron can use it. Add a custom provider under **Dev Space → AI Providers** by pasting a `curl` command with a few placeholders the app fills in per request:

| Placeholder | Replaced with |
|---|---|
| `{{API_KEY}}` | Your saved key |
| `{{MODEL}}` | The model id you set |
| `{{SYSTEM_PROMPT}}` | Your active system prompt |
| `{{TEXT}}` | The transcribed (or typed) user message |
| `{{IMAGE}}` | A base64 screenshot, for vision models |

```bash
curl https://api.your-provider.com/v1/chat/completions \
  -H "Authorization: Bearer {{API_KEY}}" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "{{MODEL}}",
    "stream": true,
    "messages": [
      {"role": "system", "content": "{{SYSTEM_PROMPT}}"},
      {"role": "user", "content": "{{TEXT}}"}
    ]
  }'
```

Then tell the app where the reply lives in the JSON response (e.g. `choices[0].message.content`) and flip on streaming if the endpoint supports it. That's it — any OpenAI-compatible or bespoke API works the same way.

## 🎧 Speech-to-Text

### Default — FluidAudio (macOS Apple Silicon, no setup)

On macOS 14+ Apple Silicon, speech recognition runs **entirely in-process** via the [`fluidaudio-rs`](https://github.com/FluidInference/fluidaudio-rs) crate (CoreML) — no server, venv, or binary to manage. Select **Local FluidAudio** under **Dev Space → STT Providers** and it just works. The first run downloads the models (~600 MB, one time); a loading overlay shows progress.

Under the hood: a CoreAudio tap captures system audio → **Silero VAD** segments speech → **Parakeet TDT** transcribes it → inverse text normalization cleans it up → the question gate decides whether to answer → speaker diarization labels the transcript when the session ends. FluidAudio delivers the final text per-utterance (no live word-by-word partials — use Parakeet below for that).

> **Heads up:** the dependency is pinned to an upstream git revision in `src-tauri/Cargo.toml` because the published crates.io `0.14.1` predates a decoder-state fix. It'll move back to a release version once one ships with the fix.

### Advanced — self-hosted STT servers (any platform)

<details>
<summary><b>faster-whisper</b> — cross-platform, runs anywhere with Python 3.12</summary>

```bash
python3.12 -m venv .whisper-venv
.whisper-venv/bin/pip install faster-whisper fastapi uvicorn python-multipart

. .whisper-venv/bin/activate
python3.12 whisper_server.py --model Systran/faster-whisper-large-v3
```

Serves at `http://localhost:8000/v1/audio/transcriptions`.
Models: `faster-whisper-tiny` · `base` · `small` · `medium` · `large-v2` · `large-v3`.
</details>

<details>
<summary><b>parakeet_server.py</b> — NVIDIA Parakeet TDT v3 on a CUDA GPU (Linux and Windows)</summary>

The model the Mac runs in-process, served over loopback. It also drives live
text and speaker labels on Linux, so a capture shows words as they are spoken
and names who said them.

```bash
python3.12 -m venv ~/.local/share/aileron-asr/venv
~/.local/share/aileron-asr/venv/bin/pip install "nemo_toolkit[asr]" fastapi uvicorn python-multipart
~/.local/share/aileron-asr/venv/bin/python parakeet_server.py --port 8001
```

Batch at `http://localhost:8001/v1/audio/transcriptions`, and
`/v1/speakers/{reset,feed,end_turn}` for speaker labels. Select **`local-parakeet`**
in speech settings. `/health` reports `loading` while the models warm up.

To keep it running across logins, a user unit (`~/.config/systemd/user/aileron-parakeet.service`):

```ini
[Unit]
Description=Aileron local Parakeet speech server
[Service]
WorkingDirectory=%h/.local/share/aileron-asr
ExecStart=%h/.local/share/aileron-asr/venv/bin/python %h/.local/share/aileron-asr/parakeet_server.py --host 127.0.0.1 --port 8001
Restart=on-failure
[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now aileron-parakeet
```

Aileron picks Local Parakeet itself when Local Whisper is not running, and says
what to start if the server is down when you begin listening.
</details>

### Cloud STT

One-click presets exist for **OpenAI Whisper, Groq Whisper, ElevenLabs, Google, Deepgram, Azure, Speechmatics, Rev.ai, and IBM Watson** — or add your own with a `curl` command, exactly like AI providers.

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `⌘⇧M` | Start / stop listening to system audio |
| `⌘⇧⏎` | Answer the last thing said (even if auto-answer skipped it) |
| `⌘⇧A` | Voice input from your microphone |
| `⌘⇧S` | Capture a screenshot |
| `⌘⇧D` | Toggle the dashboard |
| `⌘\` | Show / hide the overlay |
| `⌘⇧I` | Jump to the input box |

Every shortcut is rebindable in the dashboard. On Windows and Linux, use `Ctrl` in place of `⌘`.

## 🔒 Privacy

- **No telemetry, analytics, or tracking** — the code that phoned home is gone.
- **Direct connections only** — requests go straight from your machine to your chosen provider. No proxy, no middleware.
- **Local by default** — with Ollama + FluidAudio, audio and text never leave your device.
- **All features unlocked** — license checks are bypassed; the auto-updater is disabled (update manually via `git pull`).

## 🛠 Under the Hood

**React 19 + TypeScript + Tailwind 4 + Vite 7** on the front, **Tauri 2 (Rust)** underneath.

```
src/
  hooks/system-audio/   # capture session: STT stream socket, speaker labels
  lib/functions/        # AI + STT calls, question gate, curl templating
  pages/                # dashboard, overlay, dev space
  config/               # provider presets, shortcuts, storage keys
src-tauri/src/
  speaker/              # CoreAudio capture + VAD segmentation
  stt.rs                # FluidAudio bridge (ASR, VAD, diarization, ITN)
  shortcuts.rs          # global hotkeys
docs/                   # shipping plan + implementation notes
```

See [AGENTS.md](./AGENTS.md) for deeper architecture notes.

**Development checks:**
```bash
npx tsc --noEmit                                   # typecheck
npm run build                                      # frontend build
cargo check --manifest-path src-tauri/Cargo.toml   # Rust check
```

## 📄 License & Credits

Licensed **GPL-3.0**, inherited from the upstream project. Built on the shoulders of:

- [**Pluely**](https://github.com/iamsrikanthnani/pluely) by [Srikanth Nani](https://github.com/iamsrikanthnani) — the original project this forks
- [**fluidaudio-rs**](https://github.com/FluidInference/fluidaudio-rs) — in-process CoreML speech, VAD & diarization
- [**faster-whisper**](https://github.com/SYSTRAN/faster-whisper) · [**mlx-audio**](https://github.com/Blaizzy/mlx-audio) · [**parakeet-mlx**](https://github.com/senstella/parakeet-mlx) — self-hosted STT
- [**Ollama**](https://ollama.com) · [**LM Studio**](https://lmstudio.ai) — local model runtimes
- [**Tauri**](https://tauri.app) — the desktop framework

<div align="center">
<sub>Runs on your machine. Answers to you. 🖤</sub>
</div>
