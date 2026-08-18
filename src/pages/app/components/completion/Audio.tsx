import { lazy, Suspense } from "react";
import { InfoIcon, MicIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger, Button } from "@/components";
import { UseCompletionReturn } from "@/types";
import { useApp } from "@/contexts";
import { isMacOS } from "@/lib";
import { MicDictationButton } from "./MicDictationButton";

// Loaded only off-macOS: vad-react fetches its model/wasm from a CDN at
// runtime, so it must never initialize on the platform with the native
// dictation path.
const AutoSpeechVAD = lazy(() =>
  import("./AutoSpeechVad").then((m) => ({ default: m.AutoSpeechVAD }))
);

export const Audio = ({
  micOpen,
  setMicOpen,
  enableVAD,
  setEnableVAD,
  submit,
  setState,
}: UseCompletionReturn) => {
  const { selectedSttProvider, localApiEnabled, selectedAudioDevices } =
    useApp();

  const speechProviderStatus = selectedSttProvider.provider;
  const configured = Boolean(localApiEnabled || speechProviderStatus);

  // Configured on macOS: the native dictation button stays mounted and owns
  // the arm/disarm toggle itself. Gating it behind `enableVAD` the way the
  // web VAD path does cost a click — the first press only flipped the flag
  // and swapped this button in, and both states draw the same idle mic, so
  // it read as a dead button.
  if (configured && isMacOS()) {
    return (
      <MicDictationButton
        submit={submit}
        setState={setState}
        enableVAD={enableVAD}
        setEnableVAD={setEnableVAD}
      />
    );
  }

  // Configured + armed: render the actual voice-input control. It is NOT the
  // popover trigger — the warning popover only exists for the unconfigured
  // state, and Radix's asChild cannot wrap a Suspense boundary anyway.
  if (configured && enableVAD) {
    return (
      <Suspense
        fallback={
          <Button size="icon" title="Loading voice input…">
            <MicIcon className="h-4 w-4 text-muted-foreground" />
          </Button>
        }
      >
        <AutoSpeechVAD
          key={selectedAudioDevices.input.id}
          submit={submit}
          setState={setState}
          setEnableVAD={setEnableVAD}
          microphoneDeviceId={selectedAudioDevices.input.id}
        />
      </Suspense>
    );
  }

  return (
    // The popover exists only to explain missing provider config. When
    // configured, keep it shut: letting the trigger set micOpen expanded the
    // window 600px tall with the content `hidden` — an invisible pane that ate
    // clicks and hijacked the cursor (window is transparent + global cursor
    // override). Mic click must do exactly one thing: toggle voice detection.
    <Popover
      open={micOpen && !configured}
      onOpenChange={(open) => {
        if (!configured) {
          setMicOpen(open);
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          size="icon"
          onClick={() => {
            setEnableVAD(!enableVAD);
          }}
          className="cursor-pointer"
          title="Toggle voice input"
        >
          <MicIcon className="h-4 w-4" />
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" side="bottom" className="w-80 p-3" sideOffset={8}>
        <div className="text-sm select-none">
          <div className="font-medium text-warn mb-1">
            Speech Provider Configuration Required
          </div>
          <p className="text-muted-foreground">
            {!speechProviderStatus ? (
              <>
                <div className="mt-2 flex flex-row gap-1 items-center text-warn">
                  <InfoIcon size={16} />
                  {selectedSttProvider.provider ? null : (
                    <p>PROVIDER IS MISSING</p>
                  )}
                </div>

                <span className="block mt-2">
                  Please go to settings and configure your speech provider to
                  enable voice input.
                </span>
              </>
            ) : null}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
};
