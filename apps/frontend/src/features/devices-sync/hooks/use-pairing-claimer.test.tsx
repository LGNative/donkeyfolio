import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePairingClaimer } from "./use-pairing-claimer";

const adapterMocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  },
  beginPairingConfirm: vi.fn(),
  getPairingFlowState: vi.fn(),
  cancelPairingFlow: vi.fn(),
  approvePairingOverwrite: vi.fn(),
}));

const serviceMocks = vi.hoisted(() => ({
  syncService: {
    claimPairingSession: vi.fn(),
    pollForKeyBundle: vi.fn(),
    cancelPairing: vi.fn(),
    clearSyncData: vi.fn(),
  },
}));

const storageMocks = vi.hoisted(() => ({
  syncStorage: {
    setE2EECredentials: vi.fn(),
  },
}));

const cryptoMocks = vi.hoisted(() => ({
  computeSAS: vi.fn(),
  hmacSha256: vi.fn(),
}));

vi.mock("@/adapters", () => adapterMocks);
vi.mock("../services/sync-service", () => serviceMocks);
vi.mock("../storage/keyring", () => storageMocks);
vi.mock("../crypto", () => cryptoMocks);

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("usePairingClaimer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    serviceMocks.syncService.claimPairingSession.mockResolvedValue({
      pairingId: "pair-1",
      code: "ABC123",
      ephemeralSecretKey: "ephemeral-secret",
      ephemeralPublicKey: "ephemeral-public",
      issuerPublicKey: "issuer-public",
      sessionKey: "session-key",
      e2eeKeyVersion: 2,
      requireSas: true,
      expiresAt: new Date("2026-04-29T12:00:00Z"),
      status: "approved",
    });
    serviceMocks.syncService.pollForKeyBundle.mockResolvedValue({
      received: true,
      keyBundle: {
        version: 1,
        rootKey: "root-key",
        keyVersion: 2,
      },
      keyBundleCreatedAt: "2026-04-29T12:01:00Z",
      status: "completed",
    });
    serviceMocks.syncService.cancelPairing.mockResolvedValue({ success: true });
    serviceMocks.syncService.clearSyncData.mockResolvedValue(undefined);
    storageMocks.syncStorage.setE2EECredentials.mockResolvedValue(undefined);
    cryptoMocks.computeSAS.mockResolvedValue("123456");
    cryptoMocks.hmacSha256.mockResolvedValue("proof");
    adapterMocks.beginPairingConfirm.mockResolvedValue({
      flowId: "flow-1",
      phase: {
        phase: "overwrite_required",
        info: { localRows: 3, nonEmptyTables: [{ table: "accounts", rows: 1 }] },
      },
    });
    adapterMocks.cancelPairingFlow.mockResolvedValue({
      flowId: "flow-1",
      phase: { phase: "success" },
    });
  });

  it("clears local sync data when cancelling after overwrite consent is reached", async () => {
    const { result } = renderHook(() => usePairingClaimer(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.submitCode("ABC123");
    });

    await waitFor(() => expect(result.current.step).toBe("overwrite_required"));

    await act(async () => {
      await result.current.cancel();
    });

    expect(adapterMocks.cancelPairingFlow).toHaveBeenCalledWith("flow-1");
    expect(serviceMocks.syncService.clearSyncData).toHaveBeenCalledTimes(1);
    expect(serviceMocks.syncService.cancelPairing).not.toHaveBeenCalled();
    expect(result.current.step).toBe("enter_code");
  });
});
