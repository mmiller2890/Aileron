type Unlisten = () => void;

export function createAsyncListenerScope() {
  let active = true;
  const unlisteners = new Set<Unlisten>();

  return {
    async add(registration: Promise<Unlisten>): Promise<void> {
      const unlisten = await registration;
      if (!active) {
        unlisten();
        return;
      }
      unlisteners.add(unlisten);
    },
    guard<T extends (...args: any[]) => any>(handler: T): T {
      return ((...args: Parameters<T>) => {
        if (!active) return;
        return handler(...args);
      }) as T;
    },
    dispose(): void {
      if (!active) return;
      active = false;
      for (const unlisten of unlisteners) {
        try {
          unlisten();
        } catch {}
      }
      unlisteners.clear();
    },
  };
}
