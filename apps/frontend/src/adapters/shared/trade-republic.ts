import { invoke } from "./platform";

// ── Types ───────────────────────────────────────────────────────────────────

export interface TrStatus {
  hasCredentials: boolean;
  isConnected: boolean;
}

export interface TrLoginStarted {
  processId: string;
}

export interface TrCashEntry {
  currency: string;
  amount: string;
}

export interface TrSyncResult {
  positionsCount: number;
  activitiesCreated: number;
  cashBalances: TrCashEntry[];
}

// ── Commands ────────────────────────────────────────────────────────────────

export const trGetStatus = async (): Promise<TrStatus> => {
  return invoke<TrStatus>("tr_get_status");
};

export const trSaveCredentials = async (phoneNumber: string, pin: string): Promise<void> => {
  return invoke<void>("tr_save_credentials", { phoneNumber, pin });
};

export const trDeleteCredentials = async (): Promise<void> => {
  return invoke<void>("tr_delete_credentials");
};

export const trStartLogin = async (): Promise<TrLoginStarted> => {
  return invoke<TrLoginStarted>("tr_start_login");
};

export const trConfirmLogin = async (code: string): Promise<void> => {
  return invoke<void>("tr_confirm_login", { code });
};

export const trSyncPortfolio = async (): Promise<TrSyncResult> => {
  return invoke<TrSyncResult>("tr_sync_portfolio");
};

export const trDisconnect = async (): Promise<void> => {
  return invoke<void>("tr_disconnect");
};
