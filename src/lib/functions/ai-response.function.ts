import {
  buildDynamicMessages,
  deepVariableReplacer,
  extractVariables,
  getByPath,
  getStreamingContent,
  describeError,
  resolveCurlUrl,
  providerEndpointLabel,
  redactProviderError,
} from "./common.function";
import { Message, TYPE_PROVIDER } from "@/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import curl2Json from "@bany/curl-to-json";
import { getResponseSettings, RESPONSE_LENGTHS, LANGUAGES } from "@/lib";
import { MARKDOWN_FORMATTING_INSTRUCTIONS } from "@/config/constants";
import {
  isApiKeyOptional,
  omitEmptyApiKeyHeaders,
  withLoopbackOriginRemoved,
} from "./provider-auth";

function buildEnhancedSystemPrompt(baseSystemPrompt?: string): string {
  const responseSettings = getResponseSettings();
  const prompts: string[] = [];

  if (baseSystemPrompt) {
    prompts.push(baseSystemPrompt);
  }

  const lengthOption = RESPONSE_LENGTHS.find(
    (l) => l.id === responseSettings.responseLength,
  );
  if (lengthOption?.prompt?.trim()) {
    prompts.push(lengthOption.prompt);
  }

  const languageOption = LANGUAGES.find(
    (l) => l.id === responseSettings.language,
  );
  if (languageOption?.prompt?.trim()) {
    prompts.push(languageOption.prompt);
  }

  // Add markdown formatting instructions
  prompts.push(MARKDOWN_FORMATTING_INSTRUCTIONS);

  return prompts.join(" ");
}

/**
 * What a non-streaming provider put at `responseContentPath`. Text comes as a
 * plain string or as a list of parts (`[{ type: "text", text }]`); an explicit
 * null means the model sent none; anything else means the path is wrong.
 */
export function nonStreamingText(
  content: unknown,
):
  | { kind: "text"; text: string }
  | { kind: "declined" }
  | { kind: "unreadable" } {
  if (typeof content === "string") return { kind: "text", text: content };
  if (content === null) return { kind: "declined" };
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && typeof part.text === "string"
            ? (part.text as string)
            : null,
      )
      .filter((part): part is string => part !== null);
    if (parts.length > 0) return { kind: "text", text: parts.join("") };
    return content.length === 0 ? { kind: "declined" } : { kind: "unreadable" };
  }
  return { kind: "unreadable" };
}

export async function* fetchAIResponse(params: {
  provider: TYPE_PROVIDER | undefined;
  selectedProvider: {
    provider: string;
    variables: Record<string, string>;
  };
  systemPrompt?: string;
  history?: Message[];
  userMessage: string;
  imagesBase64?: string[];
  signal?: AbortSignal;
}): AsyncIterable<string> {
  try {
    const {
      provider,
      selectedProvider,
      systemPrompt,
      history = [],
      userMessage,
      imagesBase64 = [],
      signal,
    } = params;

    // Check if already aborted
    if (signal?.aborted) {
      return;
    }

    const enhancedSystemPrompt = buildEnhancedSystemPrompt(systemPrompt);

    if (!provider) {
      throw new Error(`Provider not provided`);
    }
    if (!selectedProvider) {
      throw new Error(`Selected provider not provided`);
    }

    let curlJson;
    try {
      curlJson = curl2Json(provider.curl);
    } catch (error) {
      throw new Error(`Failed to parse curl: ${describeError(error)}`);
    }

    const extractedVariables = extractVariables(provider.curl);
    const allVariables: Record<string, string> = {
      API_KEY: "",
      ...Object.fromEntries(
        Object.entries(selectedProvider.variables).map(([key, value]) => [
          key.toUpperCase(),
          value,
        ]),
      ),
      SYSTEM_PROMPT: enhancedSystemPrompt || "",
    };
    const resolvedUrl = resolveCurlUrl(curlJson, allVariables);
    const apiKeyOptional = isApiKeyOptional(provider.id, resolvedUrl);
    const requiredVars = extractedVariables.filter(
      ({ key }) =>
        key !== "SYSTEM_PROMPT" &&
        key !== "TEXT" &&
        key !== "IMAGE" &&
        !(apiKeyOptional && key === "API_KEY"),
    );
    for (const { key } of requiredVars) {
      if (
        !selectedProvider.variables?.[key] ||
        selectedProvider.variables[key].trim() === ""
      ) {
        throw new Error(
          `Missing required variable: ${key}. Please configure it in settings.`,
        );
      }
    }

    if (!userMessage) {
      throw new Error("User message is required");
    }
    if (imagesBase64.length > 0 && !provider.curl.includes("{{IMAGE}}")) {
      throw new Error(
        `Provider ${provider?.id ?? "unknown"} does not support image input`,
      );
    }

    let bodyObj: any = curlJson.data
      ? JSON.parse(JSON.stringify(curlJson.data))
      : {};
    const messagesKey = Object.keys(bodyObj).find((key) =>
      ["messages", "contents", "conversation", "history"].includes(key),
    );

    if (messagesKey && Array.isArray(bodyObj[messagesKey])) {
      const finalMessages = buildDynamicMessages(
        bodyObj[messagesKey],
        history,
        userMessage,
        imagesBase64,
      );
      bodyObj[messagesKey] = finalMessages;
    }

    bodyObj = deepVariableReplacer(bodyObj, allVariables);
    const url = resolvedUrl;

    const templateHeaders = (curlJson.header || {}) as Record<string, unknown>;
    let headers = deepVariableReplacer(templateHeaders, allVariables) as Record<
      string,
      string
    >;
    headers = omitEmptyApiKeyHeaders(
      headers,
      templateHeaders,
      allVariables.API_KEY,
    );
    headers["Content-Type"] = "application/json";
    headers = withLoopbackOriginRemoved(headers, url);

    if (provider?.streaming) {
      if (typeof bodyObj === "object" && bodyObj !== null) {
        const streamKey = Object.keys(bodyObj).find(
          (k) => k.toLowerCase() === "stream",
        );
        if (streamKey) {
          bodyObj[streamKey] = true;
        } else {
          bodyObj.stream = true;
        }
      }
    }

    const reasoningCapability = provider.capabilities?.reasoningEffort;
    const configuredModel = allVariables.MODEL?.trim().toLowerCase() || "";
    const supportsConfiguredModel =
      !reasoningCapability?.modelPrefixes?.length ||
      reasoningCapability.modelPrefixes.some((prefix) =>
        configuredModel.startsWith(prefix.toLowerCase()),
      );
    if (
      getResponseSettings().thinking === "off" &&
      reasoningCapability &&
      supportsConfiguredModel &&
      typeof bodyObj === "object" &&
      bodyObj !== null
    ) {
      bodyObj.reasoning_effort = reasoningCapability.offValue;
    }

    const fetchFunction = url?.startsWith("https") ? fetch : tauriFetch;

    let response;
    try {
      response = await fetchFunction(url, {
        method: curlJson.method || "POST",
        headers,
        body: curlJson.method === "GET" ? undefined : JSON.stringify(bodyObj),
        signal,
      });
    } catch (fetchError) {
      // Check if aborted
      if (
        signal?.aborted ||
        (fetchError instanceof Error && fetchError.name === "AbortError")
      ) {
        return; // Silently return on abort
      }
      // Thrown, never yielded: a yielded failure would be indistinguishable
      // from model output, so the caller would render it as the answer and
      // persist it to the conversation — poisoning the history it sends back
      // on the next turn.
      //
      // The URL is included because the overwhelmingly common cause is a local
      // provider whose server simply isn't running (Ollama not started, LM
      // Studio's server toggle off), and the bare transport message doesn't
      // say which host failed.
      const detail = redactProviderError(
        describeError(fetchError),
        allVariables,
      );
      const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(url);
      const endpoint = providerEndpointLabel(url);
      throw new Error(
        `Could not reach ${endpoint}${detail ? ` — ${detail}` : ""}.${
          isLocal
            ? " Check that the local server is running and serving this port."
            : " Check the provider URL and your connection."
        }`,
      );
    }

    if (!response.ok) {
      let errorText = "";
      try {
        errorText = await response.text();
      } catch {}
      const safeErrorText = redactProviderError(errorText, allVariables);
      throw new Error(
        `API request failed: ${response.status} ${response.statusText}${
          safeErrorText ? ` - ${safeErrorText}` : ""
        }`,
      );
    }

    if (!provider?.streaming) {
      let json;
      try {
        json = await response.json();
      } catch (parseError) {
        throw new Error(
          `Failed to parse non-streaming response: ${describeError(parseError)}`,
        );
      }
      const contentPath = provider?.responseContentPath || "";
      const content = nonStreamingText(getByPath(json, contentPath));
      if (content.kind === "declined") {
        // The path is right but the model sent no text (a refusal, a tool
        // call, or filtered output). Blaming the path would send the user to
        // fix a setting that is not wrong.
        throw new Error(
          `Provider "${
            provider?.id || "unknown"
          }" returned no text for this request (the model may have declined or tried to call a tool)`,
        );
      }
      // Without this guard an empty or wrong responseContentPath makes
      // getByPath hand back the whole parsed response, which the caller
      // renders and persists as the literal text "[object Object]".
      if (content.kind === "unreadable") {
        throw new Error(
          `Provider "${
            provider?.id || "unknown"
          }" returned a response with no text at responseContentPath "${contentPath}"`,
        );
      }
      yield content.text;
      return;
    }

    if (!response.body) {
      throw new Error("Streaming not supported or response body missing");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      // Check if aborted
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      let readResult;
      try {
        readResult = await reader.read();
      } catch (readError) {
        // Check if aborted
        if (
          signal?.aborted ||
          (readError instanceof Error && readError.name === "AbortError")
        ) {
          return; // Silently return on abort
        }
        throw new Error(`Error reading stream: ${describeError(readError)}`);
      }
      const { done, value } = readResult;
      if (done) break;

      // Check if aborted before processing
      if (signal?.aborted) {
        reader.cancel();
        return;
      }

      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (line.startsWith("data:")) {
          const trimmed = line.substring(5).trim();
          if (!trimmed || trimmed === "[DONE]") continue;
          try {
            const parsed = JSON.parse(trimmed);
            const delta = getStreamingContent(
              parsed,
              provider?.responseContentPath || "",
            );
            if (delta) {
              yield delta;
            }
          } catch (e) {
            // Ignore parsing errors for partial JSON chunks
          }
        }
      }
    }
  } catch (error) {
    // Errors raised above are already user-facing; re-wrapping them would
    // prefix every API failure with an internal function name.
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`Error in fetchAIResponse: ${String(error)}`);
  }
}
