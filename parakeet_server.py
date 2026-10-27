#!/usr/bin/env python3
"""
OpenAI-compatible transcription server running NVIDIA Parakeet TDT v3 with
NeMo on a CUDA GPU.

Parakeet TDT 0.6B v3 is the model FluidAudio runs on macOS, so Linux and
Windows machines with an NVIDIA GPU get the same transcription as the Mac.

Usage:
  python parakeet_server.py
  python parakeet_server.py --port 8001 --model nvidia/parakeet-tdt-0.6b-v3

Then select "Local Parakeet v3 (NVIDIA GPU)" as the speech provider in
Aileron, which posts to http://localhost:8001/v1/audio/transcriptions.

Install deps first (Python 3.10-3.12):
  python -m pip install "nemo_toolkit[asr]" fastapi uvicorn python-multipart
"""

import argparse
import io
import sys
import threading
import time

DEFAULT_MODEL = "nvidia/parakeet-tdt-0.6b-v3"
SAMPLE_RATE = 16_000

# Cap audio uploads at 50 MiB so a local/LAN peer cannot OOM the machine.
MAX_UPLOAD_BYTES = 50 * 1024 * 1024

INSTALL_HINT = (
    "Missing dependency. Install with:\n"
    '  python -m pip install "nemo_toolkit[asr]" fastapi uvicorn python-multipart'
)

try:
    import librosa
    import numpy as np
    import soundfile
    import torch
    from nemo.collections.asr.models import ASRModel, SortformerEncLabelModel
except ImportError:
    print(INSTALL_HINT)
    sys.exit(1)

try:
    import uvicorn
    from fastapi import FastAPI, File, HTTPException, UploadFile
except ImportError:
    print(INSTALL_HINT)
    sys.exit(1)

app = FastAPI(title="Local Parakeet Server")
model = None
model_name = DEFAULT_MODEL
device = "cpu"
# Requests run on FastAPI's threadpool; one GPU model serves them one at a time.
model_lock = threading.Lock()


# --- Live speaker labels -------------------------------------------------
#
# NeMo's streaming entry point is `forward_streaming_step`, but its step is
# `chunk_len * subsampling_factor` feature frames (188 * 8 here, about 10 s of
# audio): it is built for large chunks, not for 80 ms updates, and a smaller
# chunk fails in the encoder's fixed-width pre-encode. `forward_streaming` is
# the model's own whole-input path and chunks internally, so a turn is
# diarized by running it over the session so far. Inference over a prefix is
# deterministic, which is what keeps a slot bound to the same voice across
# turns.
SORTFORMER_MODEL = "nvidia/diar_streaming_sortformer_4spk-v2"
SPEAKER_THRESHOLD = 0.5
SPEAKER_FRAME_SECS = 0.08
MAX_SPEAKER_SESSION_SAMPLES = SAMPLE_RATE * 150
speaker_model = None
speaker_samples = np.zeros(0, dtype=np.float32)
speaker_turn_start_sample = 0


def load_speaker_model() -> None:
    global speaker_model
    if speaker_model is None:
        print(f"Loading {SORTFORMER_MODEL} on {device}...")
        loaded = SortformerEncLabelModel.from_pretrained(SORTFORMER_MODEL, map_location=device)
        loaded.eval()
        speaker_model = loaded


def diarize_counts(start_sample: int) -> list[int]:
    """Active 80 ms frames per speaker slot from `start_sample` to the end."""
    if speaker_model is None or speaker_samples.size == 0:
        return [0, 0, 0, 0]
    signal = torch.tensor(speaker_samples, dtype=torch.float32, device=device)[None, :]
    length = torch.tensor([signal.shape[1]], device=device)
    with torch.inference_mode():
        feats, feat_len = speaker_model.preprocessor(input_signal=signal, length=length)
        preds = speaker_model.forward_streaming(feats, feat_len)
    first_frame = int(start_sample / (SAMPLE_RATE * SPEAKER_FRAME_SECS))
    frames = preds[0][first_frame:]
    if frames.shape[0] == 0:
        return [0, 0, 0, 0]
    return [int(count) for count in (frames > SPEAKER_THRESHOLD).sum(dim=0).tolist()]


def load_model(name: str, requested_device: str) -> None:
    global model, model_name, device
    device = (
        "cuda"
        if requested_device == "auto" and torch.cuda.is_available()
        else ("cpu" if requested_device == "auto" else requested_device)
    )
    print(f"Loading {name} on {device}...")
    loaded = ASRModel.from_pretrained(model_name=name, map_location=device)
    loaded.eval()
    # First calls pay for resampler setup and CUDA kernel selection per audio
    # length (measured on an RTX 3080: 503 ms for the first 7 s clip, 50 ms
    # after). Pay it at startup with 48 kHz audio, as Aileron uploads it, at a
    # few turn lengths.
    rng = np.random.default_rng(0)
    for seconds in (1, 7, 30):
        capture = (rng.standard_normal(48_000 * seconds) * 0.01).astype(np.float32)
        audio = librosa.resample(capture, orig_sr=48_000, target_sr=SAMPLE_RATE, res_type="soxr_hq")
        with torch.inference_mode():
            loaded.transcribe([audio], batch_size=1, verbose=False)
    model, model_name = loaded, name
    load_speaker_model()


def decode_audio(audio_bytes: bytes) -> np.ndarray:
    """Mono float32 at 16 kHz, from any format soundfile reads (Aileron sends WAV)."""
    samples, rate = soundfile.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    if rate != SAMPLE_RATE:
        mono = librosa.resample(mono, orig_sr=rate, target_sr=SAMPLE_RATE, res_type="soxr_hq")
    return np.ascontiguousarray(mono, dtype=np.float32)


@app.post("/v1/audio/transcriptions")
def transcribe(file: UploadFile = File(...)):
    # Read at most MAX_UPLOAD_BYTES + 1: more than the cap means the upload
    # exceeds the limit (reject rather than OOM on `file.read()`).
    audio_bytes = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Audio file exceeds the {MAX_UPLOAD_BYTES // (1024 * 1024)} MiB upload limit",
        )
    try:
        audio = decode_audio(audio_bytes)
    except Exception as error:  # unreadable or empty upload
        raise HTTPException(status_code=400, detail=f"Could not read audio: {error}") from error
    if audio.size == 0:
        return {"text": ""}

    with model_lock:
        if model is None:
            # Imported directly (e.g. `uvicorn parakeet_server:app`): main()
            # did not load the model, so load the default now.
            load_model(DEFAULT_MODEL, "auto")
        started = time.perf_counter()
        with torch.inference_mode():
            result = model.transcribe([audio], batch_size=1, verbose=False)[0]
        elapsed = time.perf_counter() - started

    text = result.text if hasattr(result, "text") else str(result)
    return {
        "text": text.strip(),
        "duration": round(audio.size / SAMPLE_RATE, 3),
        "processing_time": round(elapsed, 3),
    }


@app.get("/health")
def health():
    return {"status": "ok" if model is not None else "loading", "model": model_name, "device": device}


@app.post("/v1/speakers/reset")
def speakers_reset():
    global speaker_samples, speaker_turn_start_sample
    with model_lock:
        speaker_samples = np.zeros(0, dtype=np.float32)
        speaker_turn_start_sample = 0
    return {}


@app.post("/v1/speakers/feed")
def speakers_feed(file: UploadFile = File(...)):
    global speaker_samples, speaker_turn_start_sample
    audio_bytes = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(audio_bytes) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Audio chunk exceeds the upload limit")
    try:
        audio = decode_audio(audio_bytes)
    except Exception as error:  # unreadable or empty upload
        raise HTTPException(status_code=400, detail=f"Could not read audio: {error}") from error
    with model_lock:
        trimmed = speaker_samples.size + audio.size > MAX_SPEAKER_SESSION_SAMPLES
        speaker_samples = np.concatenate([speaker_samples, audio])[-MAX_SPEAKER_SESSION_SAMPLES:]
        if trimmed:
            # The window slid past the turn's start: count from what is left.
            speaker_turn_start_sample = 0
    # Diarizing happens when the turn ends: a partial label is not worth a
    # model run per 320 ms of audio.
    return {"counts": [0, 0, 0, 0]}


@app.post("/v1/speakers/end_turn")
def speakers_end_turn():
    global speaker_turn_start_sample
    with model_lock:
        counts = diarize_counts(speaker_turn_start_sample)
        speaker_turn_start_sample = int(speaker_samples.size)
    return {"counts": counts}


def main():
    parser = argparse.ArgumentParser(description="Local Parakeet (NeMo) transcription server")
    parser.add_argument("--model", default=DEFAULT_MODEL,
                        help=f"NeMo ASR model on Hugging Face (default: {DEFAULT_MODEL})")
    parser.add_argument("--host", default="127.0.0.1",
                        help="Interface to bind (default: 127.0.0.1 loopback only; "
                             "use 0.0.0.0 ONLY if LAN access is intended - the server has no auth)")
    parser.add_argument("--port", type=int, default=8001, help="Port to listen on (default: 8001)")
    parser.add_argument("--device", default="auto", help="Device: auto, cuda or cpu")
    args = parser.parse_args()

    with model_lock:
        load_model(args.model, args.device)
    print(f"Model ready on {device}. Server starting on http://{args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port)


if __name__ == "__main__":
    main()
