# fluidaudio-rs

This directory vendors the MIT-licensed `FluidInference/fluidaudio-rs` project
from commit `2d1083314104c812944b5150866d1e334db8eed7` and contains local changes for
Assistant's FluidAudio integration.

Upstream: https://github.com/FluidInference/fluidaudio-rs

The Swift package dependency is pinned separately in `Package.swift`.

Assistant carries these intentional bridge changes on top of that upstream
revision:

- one-shot file and sample transcription construct a fresh `TdtDecoderState`
  for every call, preventing decoder history from leaking between utterances;
- recurrent VAD state is retained only by the streaming VAD API and can be
  reset explicitly at the start of each capture session;
- raw mono sample conversion uses AVFoundation's `AVAudioConverter`;
- ASR initialization supports explicit English v2 and multilingual v3 model
  selection;
- native inverse-text-normalization results remain available separately from
  raw ASR text.
