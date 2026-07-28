import { Message } from "@/types";

export function getByPath(obj: any, path: string): any {
  if (!path) return obj;
  return path
    .replace(/\[/g, ".")
    .replace(/\]/g, "")
    .split(".")
    .reduce((o, k) => (o || {})[k], obj);
}

export function setByPath(obj: any, path: string, value: any): void {
  const keys = path.split(".");
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i].replace(/\[(\d+)\]/g, ".$1");
    if (!current[key]) current[key] = /^\d+$/.test(keys[i + 1]) ? [] : {};
    current = current[key];
  }
  current[keys[keys.length - 1].replace(/\[(\d+)\]/g, ".$1")] = value;
}

export async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = () => {
      const base64data = (reader.result as string)?.split(",")[1] ?? "";
      resolve(base64data);
    };
    reader.onerror = reject;
  });
}

/**
 * Decodes a base64-encoded WAV blob into 16kHz mono f32 samples.
 * Uses the Web Audio API. If AudioContext is unavailable in the runtime,
 * this will reject.
 */
export async function wavBase64ToF32Samples(base64: string): Promise<Float32Array> {
  const rawBase64 = base64.includes(",") ? base64.split(",")[1] : base64;
  if (!rawBase64 || rawBase64.length < 100) {
    throw new Error(`Invalid base64 WAV: length ${rawBase64?.length ?? 0}`);
  }

  const binaryString = atob(rawBase64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  // Verify RIFF/WAVE header before handing to Web Audio API.
  const header = String.fromCharCode(...bytes.slice(0, 4));
  const format = String.fromCharCode(...bytes.slice(8, 12));
  if (header !== "RIFF" || format !== "WAVE") {
    throw new Error(`Invalid WAV header: ${header}/${format}`);
  }

  const blob = new Blob([bytes], { type: "audio/wav" });
  const arrayBuffer = await blob.arrayBuffer();

  const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioContextClass) {
    throw new Error("AudioContext is not available in this environment");
  }

  const audioContext = new AudioContextClass({ sampleRate: 16000 });
  try {
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const channel = audioBuffer.getChannelData(0);

    if (audioBuffer.sampleRate === 16000) {
      return channel;
    }

    const ratio = audioBuffer.sampleRate / 16000;
    const targetLength = Math.floor(channel.length / ratio);
    const resampled = new Float32Array(targetLength);
    for (let i = 0; i < targetLength; i++) {
      resampled[i] = channel[Math.floor(i * ratio)];
    }
    return resampled;
  } finally {
    await audioContext.close();
  }
}

export function extractVariables(
  curl: string,
  includeAll = false
): { key: string; value: string }[] {
  if (typeof curl !== "string") {
    return [];
  }

  const regex = /\{\{([A-Z_]+)\}\}/g;
  const matches = curl?.match(regex) || [];
  const variables = matches
    .map((match) => {
      if (typeof match === "string") {
        return match.slice(2, -2);
      }
      return "";
    })
    .filter((v) => v !== "");

  const uniqueVariables = [...new Set(variables)];

  const doNotInclude = includeAll
    ? []
    : ["SYSTEM_PROMPT", "TEXT", "IMAGE", "AUDIO"];

  const filteredVariables = uniqueVariables?.filter(
    (variable) => !doNotInclude?.includes(variable)
  );

  return filteredVariables.map((variable) => ({
    key: variable || "",
    value: variable,
  }));
}

/**
 * Recursively processes a user message template to replace placeholders for text and images.
 * @param template The user message template object.
 * @param userMessage The user's text message.
 * @param imagesBase64 An array of base64 encoded images.
 * @returns The processed user message object.
 */
export function processUserMessageTemplate(
  template: any,
  userMessage: string,
  imagesBase64: string[] = []
): any {
  const escapeForJson = (value: string) =>
    JSON.stringify(value ?? "").slice(1, -1);

  const templateStr = JSON.stringify(template).replace(
    /\{\{TEXT\}\}/g,
    escapeForJson(userMessage)
  );
  const result = JSON.parse(templateStr);

  const imageReplacer = (node: any): any => {
    if (Array.isArray(node)) {
      const imageTemplateIndex = node.findIndex((item) =>
        JSON.stringify(item).includes("{{IMAGE}}")
      );

      if (imageTemplateIndex > -1) {
        const imageTemplate = node[imageTemplateIndex];
        const imageParts =
          imagesBase64.length > 0
            ? imagesBase64.map((img) => {
                const partStr = JSON.stringify(imageTemplate).replace(
                  /\{\{IMAGE\}\}/g,
                  img
                );
                return JSON.parse(partStr);
              })
            : [];

        const finalArray = [
          ...node.slice(0, imageTemplateIndex),
          ...imageParts,
          ...node.slice(imageTemplateIndex + 1),
        ];
        return finalArray.map(imageReplacer);
      }
      return node.map(imageReplacer);
    } else if (node && typeof node === "object") {
      const newNode: { [key: string]: any } = {};
      for (const key in node) {
        newNode[key] = imageReplacer(node[key]);
      }
      return newNode;
    }
    return node;
  };

  return imageReplacer(result);
}

/**
 * Builds a dynamic messages array from a template, incorporating history and the current user message.
 * @param messagesTemplate The message template array from the cURL configuration.
 * @param history An array of previous messages in the conversation.
 * @param userMessage The user's current text message.
 * @param imagesBase64 An array of base64 encoded images for the current message.
 * @returns The fully constructed messages array.
 */
export function buildDynamicMessages(
  messagesTemplate: any[],
  history: Message[],
  userMessage: string,
  imagesBase64: string[] = []
): any[] {
  const userMessageTemplateIndex = messagesTemplate.findIndex((m) =>
    JSON.stringify(m).includes("{{TEXT}}")
  );

  if (userMessageTemplateIndex === -1) {
    return [...history, { role: "user", content: userMessage }]; // Fallback
  }

  const prefixMessages = messagesTemplate.slice(0, userMessageTemplateIndex);
  const suffixMessages = messagesTemplate.slice(userMessageTemplateIndex + 1);
  const userMessageTemplate = messagesTemplate[userMessageTemplateIndex];

  const newUserMessage = processUserMessageTemplate(
    userMessageTemplate,
    userMessage,
    imagesBase64
  );

  return [...prefixMessages, ...history, newUserMessage, ...suffixMessages];
}

/**
 * Recursively walks through an object and replaces variable placeholders.
 * @param node The object or value to process.
 * @param variables A key-value map of variables to replace.
 * @returns The processed object.
 */
/**
 * Best-effort human-readable text for a thrown value.
 *
 * `instanceof Error` alone is not enough at the Tauri boundary: the HTTP
 * plugin rejects with a plain string, which collapsed to a literal "Unknown
 * error" and hid the actual cause (connection refused, scope denied, DNS).
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
    try {
      return JSON.stringify(error);
    } catch {
      /* fall through to the generic label */
    }
  }
  return error === undefined || error === null ? "" : String(error);
}

export function providerEndpointLabel(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "provider endpoint";
  }
}

export function redactProviderError(
  text: string,
  variables: Record<string, string>
): string {
  let redacted = text.replace(
    /https?:\/\/[^\s]+/gi,
    (url) => providerEndpointLabel(url)
  );
  const secretValues = Object.entries(variables)
    .filter(
      ([key, value]) =>
        value &&
        /(api_?key|token|secret|password|authorization|auth)/i.test(key)
    )
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);

  for (const secret of secretValues) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

/**
 * Undo the URL normalisation `curl2Json` applies to variable placeholders.
 *
 * Parsing a curl command runs its URL through a URL parser, which lowercases
 * the host and percent-encodes the path. Either mangles a `{{NAME}}`
 * placeholder — `{{HOST}}` comes back as `{{host}}`, and a placeholder in the
 * path as `%7B%7BNAME%7D%7D` — so the literal, uppercase match in
 * `deepVariableReplacer` misses it and the variable is silently left
 * unsubstituted in the request URL.
 *
 * No stock provider puts a variable in its URL, but custom providers can
 * (Gemini-style `/models/{{MODEL}}:generateContent`).
 */
export function restoreUrlPlaceholders(url: string): string {
  if (typeof url !== "string") return "";
  return url
    .replace(
      /%7[Bb]%7[Bb]([A-Za-z0-9_]+)%7[Dd]%7[Dd]/g,
      (_, name: string) => `{{${name.toUpperCase()}}}`
    )
    .replace(
      /\{\{([A-Za-z0-9_]+)\}\}/g,
      (_, name: string) => `{{${name.toUpperCase()}}}`
    );
}

export function resolveCurlUrl(
  parsedCurl: {
    url?: string;
    params?: Record<string, unknown>;
  },
  variables: Record<string, string>
): string {
  let url = deepVariableReplacer(
    restoreUrlPlaceholders(parsedCurl.url || ""),
    variables
  );
  const decodedParams = Object.fromEntries(
    Object.entries(parsedCurl.params || {}).map(([key, value]) => {
      if (typeof value !== "string") return [key, ""];
      try {
        return [key, decodeURIComponent(value)];
      } catch {
        return [key, value];
      }
    })
  );
  const replacedParams = deepVariableReplacer(decodedParams, variables);
  const query = new URLSearchParams(replacedParams).toString();
  if (query) {
    url += `${url.includes("?") ? "&" : "?"}${query}`;
  }
  return url;
}

export function deepVariableReplacer(
  node: any,
  variables: Record<string, string>
): any {
  if (typeof node === "string") {
    let result = node;
    for (const [key, value] of Object.entries(variables)) {
      // Replacement *function*, not a replacement string: `$&`, `` $` ``, `$'`
      // and `$1` are special in the string form, so a transcription or system
      // prompt containing them would be silently corrupted.
      result = result.replace(
        new RegExp(`\\{\\{${key}\\}\\}`, "g"),
        () => value
      );
    }
    return result;
  }
  if (Array.isArray(node)) {
    return node.map((item) => deepVariableReplacer(item, variables));
  }
  if (node && typeof node === "object") {
    const newNode: { [key: string]: any } = {};
    for (const key in node) {
      newNode[key] = deepVariableReplacer(node[key], variables);
    }
    return newNode;
  }
  return node;
}

/**
 * Extracts content from a streaming API response chunk by trying a series of common JSON paths.
 * This makes the system more resilient to variations in streaming formats.
 * @param chunk The parsed JSON object from a stream line.
 * @param defaultPath The default, non-streaming content path for the provider.
 * @returns The extracted text content, or null if not found.
 */
export function getStreamingContent(
  chunk: any,
  defaultPath: string
): string | null {
  // A set of possible paths to check for streaming content.
  // Using a Set automatically handles duplicates.
  const possiblePaths = new Set([
    // 1. First, try a common modification for OpenAI-like providers.
    defaultPath.replace(".message.", ".delta."),
    // 2. Then, add other common patterns.
    "choices[0].delta.content", // OpenAI, Groq, Mistral, Perplexity
    "candidates[0].content.parts[0].text", // Gemini
    "delta.text", // Claude
    "text", // Cohere
    // 3. Finally, use the original path as a fallback (for Gemini and others).
    defaultPath,
  ]);

  for (const path of possiblePaths) {
    // Skip empty or null paths
    if (!path) continue;

    const content = getByPath(chunk, path);

    // We only care about non-empty string content.
    // Some paths might resolve to objects (e.g., `choices[0].delta`), so we check the type.
    if (typeof content === "string" && content) {
      return content;
    }
  }

  // Return null if no content is found after trying all paths.
  return null;
}
