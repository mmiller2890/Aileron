interface BeginCaptureSessionOptions {
  isContinuous: boolean;
  startBackend: () => Promise<void>;
  commitStarted: () => void;
}

export async function beginCaptureSession({
  isContinuous,
  startBackend,
  commitStarted,
}: BeginCaptureSessionOptions): Promise<void> {
  if (!isContinuous) {
    await startBackend();
  }
  commitStarted();
}
