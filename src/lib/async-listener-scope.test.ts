import { describe, expect, test, vi } from "vitest";
import {
  createAsyncListenerScope,
  createOwnedValueRegistry,
  createOwnedValueSlot,
  createSingleFlightInitializer,
} from "./async-listener-scope";

describe("createAsyncListenerScope", () => {
  test("unregisters a resolved listener exactly once", async () => {
    const unlisten = vi.fn();
    const scope = createAsyncListenerScope();

    await scope.add(Promise.resolve(unlisten));
    scope.dispose();
    scope.dispose();

    expect(unlisten).toHaveBeenCalledOnce();
  });

  test("unregisters a listener that resolves after disposal", async () => {
    const unlisten = vi.fn();
    let resolveRegistration: ((value: () => void) => void) | undefined;
    const registration = new Promise<() => void>((resolve) => {
      resolveRegistration = resolve;
    });
    const scope = createAsyncListenerScope();
    const added = scope.add(registration);

    scope.dispose();
    resolveRegistration?.(unlisten);
    await added;

    expect(unlisten).toHaveBeenCalledOnce();
  });

  test("blocks guarded callbacks after disposal", () => {
    const handler = vi.fn();
    const scope = createAsyncListenerScope();
    const guarded = scope.guard(handler);

    guarded("active");
    scope.dispose();
    guarded("stale");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("active");
  });

  test("lets only the replacement StrictMode scope handle an event", async () => {
    const handler = vi.fn();
    let staleCallback: ((value: string) => void) | undefined;
    let resolveStale: ((value: () => void) => void) | undefined;
    const staleRegistration = new Promise<() => void>((resolve) => {
      resolveStale = resolve;
    });
    const staleScope = createAsyncListenerScope();
    const staleAdded = staleScope.add(staleRegistration);
    staleCallback = staleScope.guard(handler);

    staleScope.dispose();

    const activeScope = createAsyncListenerScope();
    const activeCallback = activeScope.guard(handler);
    await activeScope.add(Promise.resolve(vi.fn()));

    resolveStale?.(vi.fn());
    await staleAdded;
    staleCallback("event");
    activeCallback("event");

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith("event");
  });
});

describe("createSingleFlightInitializer", () => {
  test("shares one setup across concurrent callers", async () => {
    let release: (() => void) | undefined;
    const setup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const initializer = createSingleFlightInitializer(setup);

    const first = initializer.run();
    const second = initializer.run();
    expect(setup).toHaveBeenCalledOnce();

    release?.();
    await Promise.all([first, second]);
    await initializer.run();
    expect(setup).toHaveBeenCalledOnce();
  });

  test("retries after setup rejects", async () => {
    const setup = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("registration failed"))
      .mockResolvedValueOnce();
    const initializer = createSingleFlightInitializer(setup);

    await expect(initializer.run()).rejects.toThrow("registration failed");
    await expect(initializer.run()).resolves.toBeUndefined();
    expect(setup).toHaveBeenCalledTimes(2);
  });
});

describe("owned callback storage", () => {
  test("a stale slot disposer cannot clear its replacement", () => {
    const slot = createOwnedValueSlot<() => string>();
    const first = () => "first";
    const second = () => "second";
    const disposeFirst = slot.set(first);
    const disposeSecond = slot.set(second);

    disposeFirst();
    expect(slot.get()).toBe(second);
    disposeSecond();
    expect(slot.get()).toBeNull();
  });

  test("a stale registry disposer cannot clear its replacement", () => {
    const registry = createOwnedValueRegistry<string, () => string>();
    const first = () => "first";
    const second = () => "second";
    const disposeFirst = registry.set("answer_last", first);
    const disposeSecond = registry.set("answer_last", second);

    disposeFirst();
    expect(registry.get("answer_last")).toBe(second);
    disposeSecond();
    expect(registry.get("answer_last")).toBeUndefined();
  });
});
