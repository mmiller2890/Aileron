export type ReconnectCaptureOptions = {
  isCapturing: () => boolean;
  isStopping: () => boolean;
  setStopping: (value: boolean) => void;
  stop: () => Promise<void>;
  start: () => Promise<void>;
};

export function requiresSessionBoundaryOnDeviceChange(
  providerId: string,
): boolean {
  return providerId === "local-fluidaudio";
}

export async function reconnectCapture({
  isCapturing,
  isStopping,
  setStopping,
  stop,
  start,
}: ReconnectCaptureOptions): Promise<"ignored" | "reconnected"> {
  if (!isCapturing() || isStopping()) return "ignored";

  setStopping(true);
  try {
    await stop();
    await start();
    return "reconnected";
  } finally {
    setStopping(false);
  }
}
