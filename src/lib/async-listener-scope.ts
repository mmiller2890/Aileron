type Unlisten = () => void;

export function createOwnedValueSlot<T>() {
  let current: T | null = null;

  return {
    set(value: T): () => void {
      current = value;
      return () => {
        if (current === value) current = null;
      };
    },
    get(): T | null {
      return current;
    },
  };
}

export function createOwnedValueRegistry<K, V>() {
  const values = new Map<K, V>();

  return {
    set(key: K, value: V): () => void {
      values.set(key, value);
      return () => {
        if (values.get(key) === value) values.delete(key);
      };
    },
    get(key: K): V | undefined {
      return values.get(key);
    },
    delete(key: K): void {
      values.delete(key);
    },
  };
}

export function createSingleFlightInitializer(setup: () => Promise<void>) {
  let completed = false;
  let inFlight: Promise<void> | null = null;

  return {
    run(): Promise<void> {
      if (completed) return Promise.resolve();
      if (inFlight) return inFlight;

      inFlight = setup().then(
        () => {
          completed = true;
          inFlight = null;
        },
        (error) => {
          inFlight = null;
          throw error;
        }
      );
      return inFlight;
    },
  };
}

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
