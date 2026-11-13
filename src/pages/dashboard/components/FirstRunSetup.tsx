import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AudioLinesIcon, CheckIcon, LoaderIcon } from "lucide-react";
import { AileronMark, ChevronRule } from "@/components/deco";
import { useSettings } from "@/hooks";
import { formatSttProgressPhase, useSttStatus } from "@/hooks/useSttStatus";
import { aiProviderReady, speechSetupState } from "@/lib/first-run";
import { isApiKeyOptional } from "@/lib/functions/provider-auth";
import { isMacOS } from "@/lib/platform";
import { FirstRunAi } from "./FirstRunAi";

type AccessState = "unknown" | "checking" | "waiting" | "granted" | "denied";

/** How long to watch System Settings for the permission being switched on. */
const ACCESS_POLL_SECONDS = 60;

const Step = ({
  number,
  title,
  done,
  children,
}: {
  number: number;
  title: string;
  done: boolean;
  children: React.ReactNode;
}) => (
  <section className="flex gap-3 border border-border bg-card px-4 py-4">
    <span
      aria-label={done ? "Done" : `Step ${number}`}
      className={`mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] ${
        done
          ? "bg-ok/15 text-ok"
          : "border border-border text-muted-foreground"
      }`}
    >
      {done ? <CheckIcon className="size-3" /> : number}
    </span>
    <div className="min-w-0 flex-1 space-y-2">
      <h2 className="text-sm text-foreground">{title}</h2>
      {children}
    </div>
  </section>
);

const Hint = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>
);

/**
 * The first-launch checklist: system-audio access, an AI provider, the
 * on-device speech models, then straight into a first capture. Shown once, in
 * place of the dashboard's starting screen (see `shouldShowSetup`).
 */
export const FirstRunSetup = ({
  onStartListening,
  onSkip,
}: {
  onStartListening: () => void;
  onSkip: () => void;
}) => {
  const settings = useSettings();
  const stt = useSttStatus();
  const mac = isMacOS();

  // --- System audio access (macOS) -------------------------------------
  const [access, setAccess] = useState<AccessState>("unknown");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
    },
    [],
  );
  const allowAccess = useCallback(async () => {
    if (pollRef.current) clearInterval(pollRef.current);
    setAccess("checking");
    try {
      // The first check is what makes macOS show its own prompt.
      if (await invoke<boolean>("check_system_audio_access")) {
        setAccess("granted");
        return;
      }
      await invoke("request_system_audio_access");
    } catch (error) {
      console.error("System audio access request failed:", error);
      setAccess("denied");
      return;
    }
    setAccess("waiting");
    let seconds = 0;
    pollRef.current = setInterval(async () => {
      seconds += 1;
      const granted = await invoke<boolean>("check_system_audio_access").catch(
        () => false,
      );
      if (granted || seconds >= ACCESS_POLL_SECONDS) {
        if (pollRef.current) clearInterval(pollRef.current);
        setAccess(granted ? "granted" : "denied");
      }
    }, 1000);
  }, []);

  // --- AI provider -------------------------------------------------------
  const aiEndpoint =
    settings.allAiProviders
      .find((provider) => provider.id === settings.selectedAIProvider.provider)
      ?.curl.match(/https?:\/\/[^"'\s]+/)?.[0] ?? "";
  const aiReady = aiProviderReady(
    settings.selectedAIProvider.provider,
    settings.variables.map((variable) => variable.key),
    settings.selectedAIProvider.variables,
    isApiKeyOptional(settings.selectedAIProvider.provider, aiEndpoint),
  );

  // --- On-device speech (Apple Silicon) --------------------------------
  // Downloaded here, with progress, so the first capture starts at once
  // instead of stalling on a model download.
  const usesLocalSpeech =
    stt.isSupported &&
    settings.selectedSttProvider.provider === "local-fluidaudio";
  const [preparing, setPreparing] = useState(false);
  const startedRef = useRef(false);
  const { init, initLiveText, initLiveSpeakers } = stt;
  const prepareSpeech = useCallback(async () => {
    setPreparing(true);
    try {
      // Live text and speaker labels are optional: a failed download leaves
      // capture working without them.
      if (await init("v3")) {
        await initLiveText();
        await initLiveSpeakers();
      }
    } finally {
      setPreparing(false);
    }
  }, [init, initLiveText, initLiveSpeakers]);
  useEffect(() => {
    if (!usesLocalSpeech || startedRef.current) return;
    startedRef.current = true;
    if (!stt.asrReady) void prepareSpeech();
  }, [usesLocalSpeech, stt.asrReady, prepareSpeech]);

  const stageLabel =
    stt.initStage === "live-text"
      ? "Preparing live text"
      : stt.initStage === "speakers"
        ? "Preparing speaker labels"
        : stt.progress
          ? formatSttProgressPhase(stt.progress)
          : null;
  const speech = speechSetupState({
    asrReady: stt.asrReady,
    isInitializing: preparing,
    error: stt.error,
    progressLabel: stageLabel,
    progressFraction:
      stt.initStage === "speech" ? (stt.progress?.fractionCompleted ?? null) : null,
  });

  let stepNumber = 0;
  return (
    <div className="flex h-full w-full justify-center overflow-y-auto px-6 py-12">
      <div className="flex w-full max-w-[640px] flex-col gap-5">
        <div className="flex flex-col items-center gap-4 select-none">
          <AileronMark size={56} />
          <h1
            className="text-center text-2xl tracking-[0.14em] text-foreground"
            style={{ fontFamily: "var(--font-display)", fontWeight: 500 }}
          >
            Set up Aileron.
          </h1>
          <ChevronRule className="w-40" />
        </div>

        {mac && (
          <Step
            number={++stepNumber}
            title="Let Aileron hear your calls"
            done={access === "granted"}
          >
            <Hint>
              Aileron listens to what plays through this Mac (the other side
              of a call) and transcribes it on this machine. macOS asks for
              screen &amp; system audio recording access.
            </Hint>
            {access === "granted" ? (
              <Hint>Access granted.</Hint>
            ) : (
              <>
                <button
                  type="button"
                  onClick={allowAccess}
                  disabled={access === "checking" || access === "waiting"}
                  className="inline-flex h-8 items-center gap-1.5 border border-primary/50 bg-primary/10 px-3 font-mono text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-60"
                >
                  {(access === "checking" || access === "waiting") && (
                    <LoaderIcon className="size-3.5 animate-spin" />
                  )}
                  {access === "denied" ? "try again" : "allow access"}
                </button>
                {access === "waiting" && (
                  <Hint>
                    Switch Aileron on in System Settings → Privacy &amp;
                    Security → Screen &amp; System Audio Recording. This page
                    updates by itself.
                  </Hint>
                )}
                {access === "denied" && (
                  <Hint>
                    Not granted yet. If you switched it on, quit and reopen
                    Aileron, then try again.
                  </Hint>
                )}
              </>
            )}
          </Step>
        )}

        <Step
          number={++stepNumber}
          title="Choose the AI that answers"
          done={aiReady}
        >
          <FirstRunAi settings={settings} ready={aiReady} />
        </Step>

        {usesLocalSpeech && (
          <Step
            number={++stepNumber}
            title="On-device speech recognition"
            done={speech.kind === "ready"}
          >
            {speech.kind === "ready" && (
              <Hint>Ready. Speech is transcribed on this Mac.</Hint>
            )}
            {speech.kind === "waiting" && <Hint>Checking the speech models…</Hint>}
            {speech.kind === "preparing" && (
              <div className="space-y-1.5">
                <Hint>
                  {speech.label}
                  {speech.fraction !== null
                    ? ` · ${Math.round(speech.fraction * 100)}%`
                    : "…"}
                </Hint>
                <div
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={
                    speech.fraction !== null
                      ? Math.round(speech.fraction * 100)
                      : undefined
                  }
                  className="h-1 w-full overflow-hidden bg-secondary"
                >
                  <div
                    className={`h-full bg-primary transition-[width] ${
                      speech.fraction === null ? "w-1/3 animate-pulse" : ""
                    }`}
                    style={
                      speech.fraction !== null
                        ? { width: `${Math.round(speech.fraction * 100)}%` }
                        : undefined
                    }
                  />
                </div>
              </div>
            )}
            {speech.kind === "failed" && (
              <>
                <Hint>Couldn't prepare the speech models: {speech.message}</Hint>
                <button
                  type="button"
                  onClick={() => void prepareSpeech()}
                  className="inline-flex h-8 items-center border border-border px-3 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  try again
                </button>
              </>
            )}
          </Step>
        )}

        <Step number={++stepNumber} title="Try it" done={false}>
          <Hint>
            Start listening, then play any video of someone talking. Their
            words appear as a transcript, and questions get an answer.
          </Hint>
          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={onStartListening}
              disabled={!aiReady}
              title={aiReady ? undefined : "Choose an AI provider first"}
              className="inline-flex h-8 items-center gap-1.5 border border-primary/50 bg-primary/10 px-3 font-mono text-xs text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
            >
              <AudioLinesIcon className="size-3.5" />
              start listening
            </button>
            <button
              type="button"
              onClick={onSkip}
              className="font-mono text-xs text-meta transition-colors hover:text-foreground"
            >
              skip setup
            </button>
          </div>
          {!aiReady && <Hint>Choose an AI provider above to start.</Hint>}
        </Step>
      </div>
    </div>
  );
};
