import { Label, Header } from "@/components";
import { useApp } from "@/contexts";
import { useState, useEffect } from "react";
import { getResponseSettings, updateThinking } from "@/lib";
import { THINKING_MODES, type ThinkingMode } from "@/lib";

export const ThinkingModeSelector = () => {
  const { hasActiveLicense, selectedAIProvider, allAiProviders } = useApp();
  const [thinking, setThinking] = useState<ThinkingMode>("default");
  const provider = allAiProviders.find(
    (candidate) => candidate.id === selectedAIProvider.provider
  );
  const capability = provider?.capabilities?.reasoningEffort;
  const model = selectedAIProvider.variables.MODEL?.trim().toLowerCase() || "";
  const isSupported =
    Boolean(capability) &&
    (!capability?.modelPrefixes?.length ||
      capability.modelPrefixes.some((prefix) =>
        model.startsWith(prefix.toLowerCase())
      ));

  useEffect(() => {
    setThinking(getResponseSettings().thinking);
  }, []);

  const handleSelect = (mode: ThinkingMode) => {
    if (!hasActiveLicense) return;
    setThinking(mode);
    updateThinking(mode);
  };

  return (
    <div className="space-y-4">
      <Header
        title="Thinking"
        description="Reasoning models can spend most of their output thinking before the first visible word. Turning this off asks for a direct answer instead — the single biggest lever on how long a live answer takes to appear."
        isMainTitle
      />

      <div className="grid gap-3">
        {THINKING_MODES.map((option) => {
          const selected = thinking === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => handleSelect(option.id)}
              disabled={!hasActiveLicense}
              aria-pressed={selected}
              className={`rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${
                selected
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-input"
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <Label className="text-sm font-medium cursor-pointer">
                  {option.title}
                </Label>
                <span
                  className={`size-3 shrink-0 rounded-full border ${
                    selected ? "border-primary bg-primary" : "border-border"
                  }`}
                />
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {option.description}
              </p>
            </button>
          );
        })}
      </div>

      <p className="text-[10px] text-muted-foreground">
        {isSupported
          ? "The selected provider and model support disabling reasoning."
          : "The selected provider or model has not declared support, so its default is preserved. Custom providers can opt in from their configuration."}
      </p>
    </div>
  );
};
