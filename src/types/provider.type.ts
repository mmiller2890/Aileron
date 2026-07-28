export interface ProviderCapabilities {
  reasoningEffort?: {
    offValue: "none";
    modelPrefixes?: string[];
  };
  warmup?: "ollama";
}

export interface TYPE_PROVIDER {
  id?: string;
  name?: string;
  streaming?: boolean;
  streamingUrl?: string;
  responseContentPath?: string;
  isCustom?: boolean;
  platform?: string;
  capabilities?: ProviderCapabilities;
  curl: string;
}
