#!/usr/bin/env python3
"""
Minimal OpenAI-compatible Whisper transcription server.
Uses faster-whisper to run any Hugging Face Whisper model locally.

Usage:
  python3 whisper_server.py
  python3 whisper_server.py --model openai/whisper-large-v3-turbo --port 8000

Then point the app's STT provider to http://localhost:8000/v1/audio/transcriptions

Install deps first:
  python3.12 -m pip install faster-whisper fastapi uvicorn python-multipart
"""

import argparse
import io
import sys

# Fallback model when the module is imported directly (e.g. `uvicorn whisper_server:app`)
# without going through main()'s --model argument. Must match main()'s default.
DEFAULT_MODEL = "openai/whisper-large-v3-turbo"

# Cap audio uploads at 50 MiB so a local/LAN peer cannot OOM the machine.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

try:
    from faster_whisper import WhisperModel
except ImportError:
    print("Missing dependency. Install with:\n  python3.12 -m pip install faster-whisper fastapi uvicorn python-multipart")
    sys.exit(1)

try:
    from fastapi import FastAPI, UploadFile, File, Form, HTTPException
    import uvicorn
except ImportError:
    print("Missing dependency. Install with:\n  python3.12 -m pip install faster-whisper fastapi uvicorn python-multipart")
    sys.exit(1)

app = FastAPI(title="Local Whisper Server")
model: WhisperModel | None = None


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model_name: str = Form(default="")):
    # Read at most MAX_UPLOAD_BYTES + 1: if we get more than the cap, the
    # upload exceeds the limit (reject rather than OOM on `file.read()`).
    audio_bytes = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit",
        )

    global model
    if model is None:
        # Module run directly (e.g. `uvicorn whisper_server:app`) skips
        # main(), which is where the model is normally loaded. Load the
        # default model lazily instead of crashing with a 500.
        print(f"Loading default model: {DEFAULT_MODEL} (device=auto, compute_type=default)...")
        model = WhisperModel(DEFAULT_MODEL, device="auto", compute_type="default")

    segments, info = model.transcribe(io.BytesIO(audio_bytes), beam_size=5)
    text = " ".join(seg.text for seg in segments).strip()
    return {"text": text}


@app.get("/health")
async def health():
    return {"status": "ok"}


def main():
    parser = argparse.ArgumentParser(description="Local Whisper transcription server")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"CTranslate2-format model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Interface to bind (default: 127.0.0.1 loopback only; "
                             "use 0.0.0.0 ONLY if LAN access is intended - the server has no auth)")
    parser.add_argument("--port", type=int, default=8000, help="Port to listen on")
    parser.add_argument("--device", default="auto", help="Device: auto, cpu, cuda, or mps")
    parser.add_argument("--compute-type", default="default", help="Compute type: default, int8, float16, etc.")
    args = parser.parse_args()

    global model
    print(f"Loading model: {args.model} (device={args.device}, compute_type={args.compute_type})...")
    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    print(f"Model loaded. Server starting on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()