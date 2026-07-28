import { useEffect } from "react";
import { useApp } from "@/contexts";
import {
  resolveWarmupTarget,
  warmUpModel,
  WARMUP_HEARTBEAT_MS,
} from "@/lib/functions/model-warmup";

/**
 * Keep the configured local model resident so questions don't pay a cold load.
 *
 * An unloaded model costs seconds on the first token (a 24GB model can take
 * ~10s off disk), which reads to the user as "the AI is slow". Ollama unloads
 * after 5 minutes idle by default, and a normal completion resets that timer
 * rather than extending it, so a one-shot preload isn't enough — this touches
 * the model on an interval for as long as the app is running.
 *
 * Entirely best-effort: failures are silent and never block a request.
 */
export const useModelWarmup = (enabled = true) => {
  const { selectedAIProvider, allAiProviders } = useApp();

  const provider = allAiProviders.find(
    (p) => p.id === selectedAIProvider.provider
  );
  const target = resolveWarmupTarget(provider, selectedAIProvider);

  const url = target?.url;
  const model = target?.model;

  useEffect(() => {
    if (!enabled || !url || !model) return;

    const controller = new AbortController();
    let inFlight = false;

    const touch = async () => {
      // A cold touch blocks until the weights are loaded; don't stack them up
      // if the heartbeat fires again while one is still running.
      if (inFlight) return;
      inFlight = true;
      try {
        await warmUpModel({ url, model }, controller.signal);
      } finally {
        inFlight = false;
      }
    };

    void touch();
    const interval = setInterval(touch, WARMUP_HEARTBEAT_MS);

    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [enabled, url, model]);
};
