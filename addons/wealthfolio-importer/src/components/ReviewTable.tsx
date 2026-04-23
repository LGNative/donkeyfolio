import React, { memo, useCallback, useMemo, useRef } from 'react';
import { ACTIVITY_TYPES, type ExtractedTransaction } from '../services/prompt';
import type { FieldFlag } from '../services/ai';

interface ReviewTableProps {
  transactions: ExtractedTransaction[];
  onChange: (transactions: ExtractedTransaction[]) => void;
  flagsByIndex: Map<number, FieldFlag[]>;
}

const cellStyle: React.CSSProperties = {
  padding: '4px',
  borderBottom: '1px solid var(--border)',
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '4px 8px',
  borderRadius: '4px',
  border: '1px solid var(--border)',
  background: 'var(--background)',
  color: 'var(--foreground)',
  fontSize: '12px',
  boxSizing: 'border-box',
};

interface RowProps {
  row: ExtractedTransaction;
  index: number;
  flags: FieldFlag[];
  onUpdate: (index: number, field: keyof ExtractedTransaction, value: string | number) => void;
  onDelete: (index: number) => void;
}

function flagFor(flags: FieldFlag[], field: keyof ExtractedTransaction): string | undefined {
  const flag = flags.find(f => f.field === field);
  return flag?.reason;
}

function inputProps(flags: FieldFlag[], field: keyof ExtractedTransaction, base: React.CSSProperties) {
  const reason = flagFor(flags, field);
  return {
    style: reason ? { ...base, border: '1px solid hsl(38 92% 50%)' } : base,
    title: reason || undefined,
  };
}

const TransactionRow = memo(function TransactionRow({ row, index, flags, onUpdate, onDelete }: RowProps) {
  return (
    <tr>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'date', { ...inputStyle, minWidth: '160px' })} maxLength={30} value={row.date} onChange={(e) => onUpdate(index, 'date', e.target.value)} />
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'symbol', { ...inputStyle, minWidth: '80px' })} maxLength={20} value={row.symbol} onChange={(e) => onUpdate(index, 'symbol', e.target.value)} />
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'quantity', { ...inputStyle, minWidth: '70px' })} type="number" step="any" value={row.quantity} onChange={(e) => onUpdate(index, 'quantity', +e.target.value)} />
      </td>
      <td style={cellStyle}>
        <select
          style={{ ...inputStyle, minWidth: '100px' }}
          value={row.activityType}
          onChange={(e) => onUpdate(index, 'activityType', e.target.value)}
        >
          {ACTIVITY_TYPES.map((t) => (
            <option key={t} value={t}>{t}</option>
          ))}
        </select>
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'unitPrice', { ...inputStyle, minWidth: '80px' })} type="number" step="any" value={row.unitPrice} onChange={(e) => onUpdate(index, 'unitPrice', +e.target.value)} />
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'currency', { ...inputStyle, minWidth: '50px' })} maxLength={5} value={row.currency} onChange={(e) => onUpdate(index, 'currency', e.target.value)} />
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'fee', { ...inputStyle, minWidth: '60px' })} type="number" step="any" value={row.fee} onChange={(e) => onUpdate(index, 'fee', +e.target.value)} />
      </td>
      <td style={cellStyle}>
        <input {...inputProps(flags, 'amount', { ...inputStyle, minWidth: '80px' })} type="number" step="any" value={row.amount} onChange={(e) => onUpdate(index, 'amount', +e.target.value)} />
      </td>
      <td style={cellStyle}>
        <button
          onClick={() => onDelete(index)}
          title="Delete row"
          aria-label="Delete row"
          style={{ background: 'none', border: 'none', color: 'hsl(0 84% 60%)', cursor: 'pointer', fontSize: '16px', padding: '2px 6px' }}
        >
          ×
        </button>
      </td>
    </tr>
  );
});

export function ReviewTable({ transactions, onChange, flagsByIndex }: ReviewTableProps) {
  const txRef = useRef(transactions);
  txRef.current = transactions;

  const totalWarnings = useMemo(
    () => Array.from(flagsByIndex.values()).reduce((sum, flags) => sum + flags.length, 0),
    [flagsByIndex],
  );

  const updateRow = useCallback((index: number, field: keyof ExtractedTransaction, value: string | number) => {
    const updated = [...txRef.current];
    updated[index] = { ...updated[index], [field]: value };
    onChange(updated);
  }, [onChange]);

  const deleteRow = useCallback((index: number) => {
    onChange(txRef.current.filter((_, i) => i !== index));
  }, [onChange]);

  function addRow() {
    onChange([
      ...transactions,
      {
        date: new Date().toISOString().split('T')[0] + 'T00:00:00.000Z',
        symbol: '',
        quantity: 0,
        activityType: 'BUY',
        unitPrice: 0,
        currency: 'USD',
        fee: 0,
        amount: 0,
      },
    ]);
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '13px', color: 'var(--muted-foreground)' }}>
          {transactions.length} transaction{transactions.length !== 1 ? 's' : ''}
          {totalWarnings > 0 && (
            <span style={{ color: 'hsl(38 92% 50%)', marginLeft: '8px' }}>
              ({totalWarnings} warning{totalWarnings !== 1 ? 's' : ''})
            </span>
          )}
        </span>
        <button
          onClick={addRow}
          style={{ padding: '4px 12px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer', fontSize: '12px' }}
        >
          + Add Row
        </button>
      </div>

      {transactions.length === 0 ? (
        <p style={{ textAlign: 'center', padding: '20px', color: 'var(--muted-foreground)', fontSize: '13px' }}>
          No transactions extracted. Try a different document or add rows manually.
        </p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
            <thead>
              <tr>
                {['Date', 'Symbol', 'Qty', 'Type', 'Price', 'CCY', 'Fee', 'Amount', 'Actions'].map((h) => (
                  <th key={h} style={{ ...cellStyle, textAlign: 'left', fontWeight: 600, borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap' }}>
                    {h === 'Actions' ? '' : h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {transactions.map((row, i) => (
                <TransactionRow key={`${row.date}-${row.symbol}-${i}`} row={row} index={i} flags={flagsByIndex.get(i) ?? []} onUpdate={updateRow} onDelete={deleteRow} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
