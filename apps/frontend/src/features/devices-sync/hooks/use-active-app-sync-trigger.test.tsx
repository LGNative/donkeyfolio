import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useActiveAppSyncTrigger } from "./use-active-app-sync-trigger";

const adapterMocks = vi.hoisted(() => ({
  syncTriggerCycle: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  syncStorage: {
    getDeviceId: vi.fn(),
    getRootKey: vi.fn(),
  },
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("../storage/keyring", () => storageMocks);

function setVisibilityState(value: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value,
  });
}

function setDocumentHasFocus(value: boolean) {
  Object.defineProperty(document, "hasFocus", {
    configurable: true,
    value: () => value,
  });
}

async function flushLifecycleTrigger() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("useActiveAppSyncTrigger", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00Z"));
    vi.clearAllMocks();
    adapterMocks.syncTriggerCycle.mockResolvedValue(undefined);
    storageMocks.syncStorage.getDeviceId.mockResolvedValue("device-1");
    storageMocks.syncStorage.getRootKey.mockResolvedValue("root-key");
    setVisibilityState("visible");
    setDocumentHasFocus(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not trigger sync when disabled", async () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: false }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();
    expect(storageMocks.syncStorage.getDeviceId).not.toHaveBeenCalled();
    expect(storageMocks.syncStorage.getRootKey).not.toHaveBeenCalled();
  });

  it("triggers sync on focus, visibility, and online events", async () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(30_000);
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("online"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(3);
  });

  it("throttles repeated lifecycle events", async () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(29_999);
      window.dispatchEvent(new Event("focus"));
    });
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);
  });

  it("triggers sync every minute while visible", async () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);
  });

  it("does not run interval sync while hidden", async () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      setVisibilityState("hidden");
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();

    act(() => {
      setVisibilityState("visible");
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);
  });

  it("does not run desktop interval sync while visible but unfocused", async () => {
    setDocumentHasFocus(false);
    renderHook(() =>
      useActiveAppSyncTrigger({ enabled: true, requireWindowFocusForInterval: true }),
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();

    act(() => {
      setDocumentHasFocus(true);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);
  });

  it("keeps mobile interval sync based on visibility without requiring focus", async () => {
    setDocumentHasFocus(false);
    renderHook(() =>
      useActiveAppSyncTrigger({ enabled: true, requireWindowFocusForInterval: false }),
    );

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);
  });

  it("ignores hidden visibility changes and swallowed sync failures", async () => {
    adapterMocks.syncTriggerCycle.mockRejectedValue(new Error("offline"));
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(30_000);
      setVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);
  });

  it("allows online to retry immediately after a failed attempt", async () => {
    adapterMocks.syncTriggerCycle
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new Event("online"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);
  });

  it("throttles repeated online recovery retries after failure", async () => {
    adapterMocks.syncTriggerCycle.mockRejectedValue(new Error("offline"));
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5_000);
      window.dispatchEvent(new Event("online"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(1);
      window.dispatchEvent(new Event("online"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(2);

    act(() => {
      vi.advanceTimersByTime(29_999);
      window.dispatchEvent(new Event("online"));
    });
    await flushLifecycleTrigger();
    expect(adapterMocks.syncTriggerCycle).toHaveBeenCalledTimes(3);
  });

  it("suppresses startup lifecycle events during the initial throttle window", () => {
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();
    expect(storageMocks.syncStorage.getDeviceId).not.toHaveBeenCalled();
    expect(storageMocks.syncStorage.getRootKey).not.toHaveBeenCalled();
  });

  it("skips automatic sync when local device sync identity is incomplete", async () => {
    storageMocks.syncStorage.getRootKey.mockResolvedValue(null);
    renderHook(() => useActiveAppSyncTrigger({ enabled: true }));

    act(() => {
      vi.advanceTimersByTime(30_000);
      window.dispatchEvent(new Event("focus"));
    });

    await flushLifecycleTrigger();
    expect(storageMocks.syncStorage.getRootKey).toHaveBeenCalledTimes(1);
    expect(adapterMocks.syncTriggerCycle).not.toHaveBeenCalled();
  });
});
