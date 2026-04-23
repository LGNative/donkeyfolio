// Type declarations for Wealthfolio addon SDK
// Derived from @wealthfolio/addon-sdk at github.com/afadil/wealthfolio (v3.0.0)

import React from 'react';

export interface Account {
  id: string;
  name: string;
  currency: string;
  accountType: string;
}

export interface ActivityImport {
  id?: string;
  accountId: string;
  currency?: string;
  activityType: string;
  subtype?: string;
  date?: Date | string;
  symbol?: string;
  amount?: number | string | null;
  quantity?: number | string | null;
  unitPrice?: number | string | null;
  fee?: number | string | null;
  fxRate?: number | string | null;
  accountName?: string;
  symbolName?: string;
  exchangeMic?: string;
  quoteCcy?: string;
  instrumentType?: string;
  quoteMode?: string;
  errors?: Record<string, string[]>;
  warnings?: Record<string, string[]>;
  duplicateOfId?: string;
  duplicateOfLineNumber?: number;
  isValid: boolean;
  lineNumber?: number;
  isDraft: boolean;
  forceImport?: boolean;
  comment?: string;
}

export interface SecretsAPI {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

interface ImportResult {
  activities: ActivityImport[];
  summary: {
    total: number;
    imported: number;
    skipped: number;
    duplicates: number;
    success: boolean;
  };
}

export interface SidebarItemHandle {
  remove(): void;
}

export interface HostAPI {
  accounts: { getAll(): Promise<Account[]> };
  activities: {
    checkImport(activities: ActivityImport[]): Promise<ImportResult>;
    import(activities: ActivityImport[]): Promise<ImportResult>;
  };
  secrets: SecretsAPI;
  logger: { info(msg: string): void; error(msg: string): void; debug(msg: string): void };
}

export interface AddonContext {
  sidebar: {
    addItem(config: { id: string; icon: React.ReactNode; label: string; route: string; order?: number }): SidebarItemHandle;
  };
  router: {
    add(config: { path: string; component: React.LazyExoticComponent<React.ComponentType<unknown>> }): void;
  };
  onDisable: (callback: () => void) => void;
  api: HostAPI;
}
