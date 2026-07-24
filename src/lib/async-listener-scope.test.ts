import { describe, expect, test, vi } from "vitest";
import { createAsyncListenerScope } from "./async-listener-scope";

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
