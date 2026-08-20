export const microphoneStreamConstraints = (
  microphoneDeviceId?: string
): MediaStreamConstraints => ({
  audio: {
    channelCount: 1,
    echoCancellation: true,
    autoGainControl: true,
    noiseSuppression: true,
    ...(microphoneDeviceId && microphoneDeviceId !== "default"
      ? { deviceId: { exact: microphoneDeviceId } }
      : {}),
  },
});
