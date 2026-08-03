import {
  describeError,
  deepVariableReplacer,
  getByPath,
  blobToBase64,
  wavBase64ToF32Samples,
  resolveCurlUrl,
  providerEndpointLabel,
  redactProviderError,
} from "./common.function";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { invoke } from "@tauri-apps/api/core";

import { TYPE_PROVIDER } from "@/types";
import curl2Json from "@bany/curl-to-json";
import { withLoopbackOriginRemoved } from "./provider-auth";

export interface STTParams {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  /**
   * The encoded audio, or a thunk producing it.
   *
   * Pass a thunk when producing the blob is itself expensive (decoding a
   * base64 WAV) and the chosen provider may not need it at all — see
   * `utteranceId` below.
   */
  audio: File | Blob | (() => File | Blob);
  signal?: AbortSignal;
  /**
   * Handle for an utterance the Rust capture loop still holds in memory.
   *
   * When present, the local provider transcribes straight from those samples
   * instead of decoding `audio` and sending the samples back over IPC. Remote
   * providers ignore it — they need the encoded audio to upload.
   */
  utteranceId?: string;
  /**
   * Raw 16kHz mono samples, when the caller already has them (the mic VAD
   * path). Lets the local provider skip the WAV encode/decode round trip.
   */
  samples?: Float32Array;
}

export const UTTERANCE_CACHE_MISS_PREFIX = "UTTERANCE_CACHE_MISS:";

const AUDIO_PLACEHOLDER = "{{AUDIO}}";

/**
 * Find the form field that carries the audio upload. The field name is
 * provider-defined ("file", "media", "data_file", ...) and must not be
 * assumed: curl2Json parses `-F` entries either as array entries
 * ("media={{AUDIO}}") or, for a single field, as a bare string.
 */
function findAudioFieldKey(formData: Record<string, unknown>): string | null {
  for (const [key, val] of Object.entries(formData)) {
    if (typeof val !== "string" || !val.includes(AUDIO_PLACEHOLDER)) continue;
    if (!isNaN(parseInt(key, 10))) {
      const [formKey] = val.split("=");
      return formKey;
    }
    return key.toLowerCase();
  }
  return null;
}

export function isUtteranceCacheMiss(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(UTTERANCE_CACHE_MISS_PREFIX);
}

/**
 * Transcribes audio and returns either the transcription or an error/warning message as a single string.
 */
export async function fetchSTT(params: STTParams): Promise<string> {
  let warnings: string[] = [];

  try {
    const {
      provider,
      selectedProvider,
      audio: audioSource,
      signal,
      utteranceId,
      samples,
    } = params;

    if (!provider) throw new Error("Provider not provided");
    if (!selectedProvider) throw new Error("Selected provider not provided");
    if (!audioSource) throw new Error("Audio file is required");

    let resolvedAudio: File | Blob | null = null;
    const audioBlob = (): File | Blob => {
      resolvedAudio ??=
        typeof audioSource === "function" ? audioSource() : audioSource;
      return resolvedAudio;
    };

    if (provider.id === "local-fluidaudio") {
      // Fastest path: Rust already holds these samples, so transcribe in
      // place. Nothing is decoded and nothing crosses IPC but the id.
      if (utteranceId) {
        try {
          const result = await invoke<{ text: string }>(
            "stt_transcribe_utterance",
            { utteranceId }
          );
          return result.text.trim();
        } catch (error) {
          if (!isUtteranceCacheMiss(error)) {
            throw error;
          }
          // The utterance can age out of the cache during a burst of speech.
          // Falling through re-derives the samples from the audio we were
          // handed, which is why callers must still supply it.
          console.warn(
            "Utterance no longer cached, falling back to decode:",
            error
          );
        }
      }

      // Caller already has samples (mic VAD): skip the WAV round trip.
      const f32 =
        samples ?? (await wavBase64ToF32Samples(await blobToBase64(audioBlob())));
      if (f32.length === 0) throw new Error("Audio file is empty");
      const result = await invoke<{ text: string }>("stt_transcribe_speech", {
        samples: Array.from(f32),
      });
      return result.text.trim();
    }

    const audio = audioBlob();

    let curlJson: any;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(
        `Failed to parse curl: ${describeError(error)}`
      );
    }

    // Validate audio file
    const file = audio as File;
    if (file.size === 0) throw new Error("Audio file is empty");
    // maximum size of 10MB
    // const maxSize = 10 * 1024 * 1024;
    // if (file.size > maxSize) {
    //   warnings.push("Audio exceeds 10MB limit");
    // }

    // Build variable map
    const allVariables = {
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ])
      ),
    };

    // Prepare request
    const url = resolveCurlUrl(curlJson, allVariables);
    const headers = deepVariableReplacer(curlJson.header || {}, allVariables);
    const formData = deepVariableReplacer(curlJson.form || {}, allVariables);

    // To Check if API accepts Binary Data
    const isBinaryUpload = provider.curl.includes("--data-binary");
    let finalHeaders = { ...headers };
    let body: FormData | string | Blob;

    const isForm =
      provider.curl.includes("-F ") || provider.curl.includes("--form");
    if (isForm) {
      const form = new FormData();
      const freshBlob = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
      // curl2Json parses a single `-F "key=value"` into a bare string; wrap
      // it so the loop below always sees entry pairs.
      const normalizedForm =
        typeof formData === "string" ? [formData] : formData;
      // The audio field is whatever the provider template says it is
      // ("file", "media", "data_file", ...): attach the blob there instead of
      // hard-coding "file", which silently dropped the upload for providers
      // that name their field differently.
      const audioFieldKey = findAudioFieldKey(normalizedForm) ?? "file";
      form.append(audioFieldKey, freshBlob, "audio.wav");
      const headerKeys = Object.keys(headers).map((k) =>
        k.toUpperCase().replace(/[-_]/g, "")
      );

      for (const [key, val] of Object.entries(normalizedForm)) {
        if (typeof val !== "string") {
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
          continue;
        }

        // Check if key is a number, which indicates array-like parsing from curl2json
        if (!isNaN(parseInt(key, 10))) {
          const [formKey, ...formValueParts] = val.split("=");
          const formValue = formValueParts.join("=");

          // The audio field is already attached as a blob above.
          if (
            val.includes(AUDIO_PLACEHOLDER) ||
            formKey.toLowerCase() === "file"
          )
            continue;

          if (
            !formValue ||
            headerKeys.includes(formKey.toUpperCase().replace(/[-_]/g, ""))
          )
            continue;

          form.append(formKey, formValue);
        } else {
          // The audio field is already attached as a blob above.
          if (val.includes(AUDIO_PLACEHOLDER) || key.toLowerCase() === "file")
            continue;
          if (
            !val ||
            headerKeys.includes(key.toUpperCase()) ||
            key.toUpperCase() === "AUDIO"
          )
            continue;
          form.append(key.toLowerCase(), val as string | Blob);
        }
      }
      delete finalHeaders["Content-Type"];
      body = form;
    } else if (isBinaryUpload) {
      // Deepgram-style: raw binary body
      body = new Blob([await audio.arrayBuffer()], {
        type: audio.type,
      });
    } else {
      // Google-style: JSON payload with base64
      allVariables.AUDIO = await blobToBase64(audio);
      const dataObj = curlJson.data ? { ...curlJson.data } : {};
      body = JSON.stringify(deepVariableReplacer(dataObj, allVariables));
    }

    finalHeaders = withLoopbackOriginRemoved(finalHeaders, url);
    const fetchFunction = url?.startsWith("https") ? fetch : tauriFetch;

    // Send request
    let response: Response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers: finalHeaders,
        body: curlJson.method === "GET" ? undefined : body,
        signal,
      });
    } catch (e) {
      if (
        signal?.aborted ||
        (e instanceof Error && e.name === "AbortError")
      ) {
        throw new Error("Transcription cancelled");
      }
      // Redact secret values (API keys appear in transport errors when a
      // gateway echoes the request) and point at the likely cause, the same
      // way fetchAIResponse does.
      const detail = redactProviderError(describeError(e), allVariables);
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(
        url
      );
      const endpoint = providerEndpointLabel(url);
      throw new Error(
        `Could not reach ${endpoint}${detail ? ` — ${detail}` : ""}.${
          isLocal
            ? " Check that the local server is running and serving this port."
            : " Check the provider URL and your connection."
        }`
      );
    }

    if (!response.ok) {
      let errText = "";
      try {
        errText = await response.text();
      } catch {}
      let errMsg: string;
      try {
        const errObj = JSON.parse(errText);
        errMsg = errObj.message || errText;
      } catch {
        errMsg = errText || response.statusText;
      }
      throw new Error(
        `HTTP ${response.status}: ${redactProviderError(errMsg, allVariables)}`
      );
    }

    const responseText = await response.text();
    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch {
      return [...warnings, responseText.trim()].filter(Boolean).join("; ");
    }

    // Extract transcription
    const rawPath = provider.responseContentPath || "text";
    const path = rawPath.charAt(0).toLowerCase() + rawPath.slice(1);
    const transcription = (getByPath(data, path) || "").trim();

    if (!transcription) {
      return [...warnings, "No transcription found"].join("; ");
    }

    // Return transcription with any warnings
    return [...warnings, transcription].filter(Boolean).join("; ");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(msg);
  }
}
