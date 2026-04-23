import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { AddonContext, Account, ActivityImport } from '../types';
import type { Provider } from '../services/ai';
import type { PageContent } from '../services/pdf';
import type { ExtractedTransaction, DateFormat } from '../services/prompt';
import { extractTransactions, evaluateConfidence, ISO_DATE_RE, SYMBOL_RE, CURRENCY_RE } from '../services/ai';
import { Settings } from './Settings';
import { Upload } from './Upload';
import { ReviewTable } from './ReviewTable';

type Step = 'upload' | 'extracting' | 'review' | 'importing' | 'done';

const SPIN_STYLE = <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>;

interface ImporterPageProps {
  ctx: AddonContext;
}

export function ImporterPage({ ctx }: ImporterPageProps) {
  const [provider, setProvider] = useState<Provider>('anthropic');
  const [apiKey, setApiKey] = useState('');
  const [dateFormat, setDateFormat] = useState<DateFormat>('DD/MM/YYYY');
  const [step, setStep] = useState<Step>('upload');
  const [transactions, setTransactions] = useState<ExtractedTransaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [error, setError] = useState('');
  const [fileName, setFileName] = useState('');
  const [importResult, setImportResult] = useState('');
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: load accounts once
  useEffect(() => {
    ctx.api.accounts.getAll().then((accs) => {
      setAccounts(accs);
      if (accs.length > 0) setSelectedAccount(accs[0].id);
    }).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      setError(`Failed to load accounts: ${message}`);
    });
  }, []);

  async function handleFile(file: File) {
    setError('');
    setFileName(file.name);

    if (!apiKey) {
      setError('Please enter your API key first.');
      return;
    }

    setStep('extracting');
    setProgress(null);

    // Cancel any in-flight extraction before starting a new one
    if (abortRef.current) abortRef.current.abort();

    try {
      let pages: PageContent[];

      if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
        const { pdfToContent, LARGE_DOC_THRESHOLD } = await import('../services/pdf');
        const result = await pdfToContent(file);
        pages = result.pages;

        // eslint-disable-next-line no-restricted-globals
        if (pages.length > LARGE_DOC_THRESHOLD && !confirm(
          `This document has ${pages.length} pages. Processing may take several minutes and consume significant API credits. Continue?`,
        )) {
          setStep('upload');
          return;
        }
      } else {
        const { imageToBase64, getMediaType } = await import('../services/pdf');
        const base64 = await imageToBase64(file);
        pages = [{ mode: 'image', base64, mediaType: getMediaType(file), pageNumber: 1 }];
      }

      const abort = new AbortController();
      abortRef.current = abort;

      const extracted = await extractTransactions(provider, apiKey, pages, abort.signal, (c, t) => setProgress({ current: c, total: t }), dateFormat);
      setTransactions(extracted);
      setStep('review');
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        setStep('upload');
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
      setStep('upload');
    } finally {
      abortRef.current = null;
      setProgress(null);
    }
  }

  async function handleImport() {
    if (!selectedAccount) {
      setError('Please select an account.');
      return;
    }

    setError('');
    setStep('importing');

    try {
      const draft: ActivityImport[] = transactions.map((t, i) => {
        const date = ISO_DATE_RE.test(t.date) ? t.date : new Date().toISOString();
        const symbol = SYMBOL_RE.test(t.symbol) ? t.symbol : '';
        const currency = CURRENCY_RE.test(t.currency) ? t.currency : 'USD';
        return {
          accountId: selectedAccount,
          date,
          activityType: t.activityType,
          symbol,
          quantity: Math.max(0, Number(t.quantity) || 0),
          unitPrice: Math.max(0, Number(t.unitPrice) || 0),
          currency,
          fee: Math.max(0, Number(t.fee) || 0),
          amount: Number(t.amount) || 0,
          quoteCcy: currency,
          instrumentType: 'Equity',
          lineNumber: i + 1,
          isValid: true,
          isDraft: false,
          forceImport: false,
        };
      });

      ctx.api.logger.debug(`[AI Importer] Sending ${draft.length} activities to checkImport`);

      // Call API directly — the SDK bridge doesn't pass accountId at root level
      // which the self-hosted Axum backend requires
      async function apiCall<T>(path: string, body: unknown): Promise<T> {
        const resp = await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const text = await resp.text();
          throw new Error(`API ${resp.status}: ${text}`);
        }
        return resp.json();
      }

      const requestBody = { accountId: selectedAccount, activities: draft };

      // Resolve symbols (populates exchangeMic, symbolName, asset lookups)
      const checked = await apiCall<ActivityImport[]>(
        '/api/v1/activities/import/check',
        requestBody,
      );
      const valid = checked.filter((a) => a.isValid);
      const invalid = checked.filter((a) => !a.isValid);

      // When some transactions have unresolved symbols, ask the user to force-import
      let toImport = valid;
      let forceImported = 0;

      if (invalid.length > 0) {
        const unresolvedSymbols = [...new Set(invalid.map((a) => a.symbol).filter(Boolean))];
        const symbolList = unresolvedSymbols.length > 0
          ? unresolvedSymbols.join(', ')
          : 'unknown symbols';
        const message = valid.length > 0
          ? `${invalid.length} transaction(s) have symbols not found in market data (${symbolList}).\n\n${valid.length} transaction(s) resolved successfully.\n\nImport all transactions anyway? (unresolved symbols will be created as custom assets)`
          : `None of the ${invalid.length} transaction(s) could be resolved in market data (${symbolList}).\n\nImport them anyway? (symbols will be created as custom assets)`;

        // eslint-disable-next-line no-restricted-globals
        if (confirm(message)) {
          const forced = invalid.map((a) => ({ ...a, isValid: true, forceImport: true }));
          toImport = [...valid, ...forced];
          forceImported = forced.length;
        } else if (valid.length > 0) {
          // User declined — only import the valid ones
          toImport = valid;
        } else {
          // Nothing to import and user declined force-import
          setStep('review');
          return;
        }
      }

      const result = await apiCall<{ activities: ActivityImport[]; summary?: { imported?: number } }>(
        '/api/v1/activities/import',
        { accountId: selectedAccount, activities: toImport },
      );
      const imported = result?.summary?.imported ?? toImport.length;
      const skipped = transactions.length - toImport.length;
      let msg = `Successfully imported ${imported} transaction(s).`;
      if (forceImported > 0) msg += ` ${forceImported} with custom symbols.`;
      if (skipped > 0) msg += ` ${skipped} skipped.`;
      setImportResult(msg);
      setStep('done');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const detail = typeof err === 'object' && err !== null ? JSON.stringify(err) : '';
      ctx.api.logger.error(`[AI Importer] Import failed: ${message}`);
      if (detail && detail !== '{}') ctx.api.logger.error(`[AI Importer] Error detail: ${detail}`);
      // Show a sanitized message to the user — full details stay in the logger
      const userMessage = message.length > 200 ? message.slice(0, 200) + '…' : message;
      setError(`Import failed: ${userMessage}`);
      setStep('review');
    }
  }

  const flagsByIndex = useMemo(
    () => new Map(transactions.map((t, i) => [i, evaluateConfidence(t)] as const)),
    [transactions],
  );

  const warningCount = useMemo(
    () => Array.from(flagsByIndex.values()).reduce((sum, f) => sum + f.length, 0),
    [flagsByIndex],
  );

  function startOver() {
    setStep('upload');
    setTransactions([]);
    setError('');
    setImportResult('');
    setFileName('');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px', maxWidth: '960px' }}>
      <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 600 }}>AI Importer</h2>
      <p style={{ margin: 0, fontSize: '13px', color: 'var(--muted-foreground)' }}>
        Extract transactions from PDFs & images using AI
      </p>

      {/* Settings — always visible */}
      <div style={{ padding: '16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
        <Settings
          secrets={ctx.api.secrets}
          logger={ctx.api.logger}
          provider={provider}
          onProviderChange={setProvider}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          dateFormat={dateFormat}
          onDateFormatChange={setDateFormat}
        />
      </div>

      {/* Upload */}
      {step === 'upload' && (
        <div style={{ padding: '16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <Upload onFile={handleFile} disabled={!apiKey} />
        </div>
      )}

      {/* Extracting */}
      {step === 'extracting' && (
        <div style={{ padding: '32px 16px', borderRadius: '8px', border: '1px solid var(--border)', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', width: '24px', height: '24px', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ marginTop: '12px' }}>Extracting transactions from <strong>{fileName}</strong>...</p>
          {progress && progress.total > 1 && (
            <p style={{ marginTop: '4px', fontSize: '12px', color: 'var(--muted-foreground)' }}>
              Processing chunk {progress.current} of {progress.total}...
            </p>
          )}
          <button
            onClick={() => abortRef.current?.abort()}
            style={{ marginTop: '8px', padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer', fontSize: '13px' }}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Review */}
      {step === 'review' && (
        <div style={{ padding: '16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <ReviewTable transactions={transactions} onChange={setTransactions} flagsByIndex={flagsByIndex} />

          <div style={{ marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <label style={{ fontSize: '13px', fontWeight: 500 }}>Import to:</label>
            <select
              value={selectedAccount}
              onChange={(e) => setSelectedAccount(e.target.value)}
              style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', background: 'var(--background)', color: 'var(--foreground)', fontSize: '13px' }}
            >
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
              ))}
            </select>

            <div style={{ flex: 1 }} />

            <button
              onClick={startOver}
              style={{ padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer', fontSize: '13px' }}
            >
              Start Over
            </button>
            <button
              onClick={handleImport}
              disabled={transactions.length === 0}
              style={{ padding: '6px 16px', borderRadius: '6px', border: 'none', background: 'var(--primary)', color: 'var(--primary-foreground)', cursor: transactions.length === 0 ? 'not-allowed' : 'pointer', opacity: transactions.length === 0 ? 0.5 : 1, fontSize: '13px', fontWeight: 500 }}
            >
              Import {transactions.length} Transaction{transactions.length !== 1 ? 's' : ''}{warningCount > 0 ? ` (${warningCount} warning${warningCount !== 1 ? 's' : ''})` : ''}
            </button>
          </div>
        </div>
      )}

      {/* Importing */}
      {step === 'importing' && (
        <div style={{ padding: '32px 16px', borderRadius: '8px', border: '1px solid var(--border)', textAlign: 'center' }}>
          <div style={{ display: 'inline-block', width: '24px', height: '24px', border: '3px solid var(--border)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          <p style={{ marginTop: '12px' }}>Importing transactions...</p>
        </div>
      )}

      {/* Done */}
      {step === 'done' && (
        <div style={{ padding: '24px 16px', borderRadius: '8px', border: '1px solid var(--border)', textAlign: 'center' }}>
          <p style={{ fontSize: '14px', fontWeight: 500, color: 'hsl(142 71% 45%)' }}>{importResult}</p>
          <button
            onClick={startOver}
            style={{ marginTop: '12px', padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer', fontSize: '13px' }}
          >
            Import Another
          </button>
        </div>
      )}

      {/* Error */}
      {error && (
        <div style={{ padding: '12px 16px', borderRadius: '8px', background: 'hsl(0 84% 60% / 0.1)', color: 'hsl(0 84% 60%)', fontSize: '13px', whiteSpace: 'pre-wrap' }}>
          {error}
        </div>
      )}

      {SPIN_STYLE}
    </div>
  );
}
