import { describe, it, expect } from 'vitest';
import { validateTransaction, evaluateConfidence, parseResponse, ISO_DATE_RE, SYMBOL_RE, CURRENCY_RE } from './ai';
import { buildSystemPrompt } from './prompt';
import type { ExtractedTransaction } from './prompt';

// --- Helpers ---

function makeTxn(overrides: Partial<ExtractedTransaction> = {}): ExtractedTransaction {
  return {
    date: '2025-03-15T00:00:00.000Z',
    symbol: 'AAPL',
    quantity: 10,
    activityType: 'BUY',
    unitPrice: 150,
    currency: 'USD',
    fee: 5,
    amount: 1500,
    ...overrides,
  };
}

// --- validateTransaction ---

describe('validateTransaction', () => {
  it('passes through a valid transaction unchanged', () => {
    const input = {
      date: '2025-03-15T00:00:00.000Z',
      symbol: 'AAPL',
      quantity: 10,
      activityType: 'BUY',
      unitPrice: 150.5,
      currency: 'USD',
      fee: 4.99,
      amount: 1505,
    };
    expect(validateTransaction(input)).toEqual(input);
  });

  it('defaults missing fields to safe values', () => {
    const result = validateTransaction({});
    expect(result).toEqual({
      date: '',
      symbol: '',
      quantity: 0,
      activityType: 'BUY',
      unitPrice: 0,
      currency: 'USD',
      fee: 0,
      amount: 0,
    });
  });

  it('defaults non-object input to safe values', () => {
    expect(validateTransaction(null)).toEqual(validateTransaction({}));
    expect(validateTransaction(undefined)).toEqual(validateTransaction({}));
    expect(validateTransaction('string')).toEqual(validateTransaction({}));
    expect(validateTransaction(42)).toEqual(validateTransaction({}));
  });

  it('rejects invalid date formats', () => {
    expect(validateTransaction({ date: '03/15/2025' }).date).toBe('');
    expect(validateTransaction({ date: 'not-a-date' }).date).toBe('');
    expect(validateTransaction({ date: 12345 }).date).toBe('');
  });

  it('accepts date-only ISO format', () => {
    expect(validateTransaction({ date: '2025-03-15' }).date).toBe('2025-03-15');
  });

  it('accepts full ISO format with Z', () => {
    expect(validateTransaction({ date: '2025-03-15T00:00:00.000Z' }).date).toBe('2025-03-15T00:00:00.000Z');
  });

  it('rejects invalid symbols', () => {
    expect(validateTransaction({ symbol: 'A'.repeat(21) }).symbol).toBe('');
    expect(validateTransaction({ symbol: 'INVALID SYMBOL!' }).symbol).toBe('');
  });

  it('accepts valid symbols including cash format', () => {
    expect(validateTransaction({ symbol: '$CASH-USD' }).symbol).toBe('$CASH-USD');
    expect(validateTransaction({ symbol: 'MSFT' }).symbol).toBe('MSFT');
    expect(validateTransaction({ symbol: '' }).symbol).toBe('');
  });

  it('clamps negative quantity and unitPrice to 0', () => {
    expect(validateTransaction({ quantity: -5 }).quantity).toBe(0);
    expect(validateTransaction({ unitPrice: -10 }).unitPrice).toBe(0);
    expect(validateTransaction({ fee: -3 }).fee).toBe(0);
  });

  it('allows negative amount', () => {
    expect(validateTransaction({ amount: -500 }).amount).toBe(-500);
  });

  it('rejects non-finite numbers', () => {
    expect(validateTransaction({ quantity: Infinity }).quantity).toBe(0);
    expect(validateTransaction({ quantity: NaN }).quantity).toBe(0);
    expect(validateTransaction({ amount: Infinity }).amount).toBe(0);
  });

  it('defaults unknown activityType to BUY', () => {
    expect(validateTransaction({ activityType: 'UNKNOWN' }).activityType).toBe('BUY');
    expect(validateTransaction({ activityType: 123 }).activityType).toBe('BUY');
  });

  it('accepts all valid activity types', () => {
    const types = ['BUY', 'SELL', 'SPLIT', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL',
      'TRANSFER_IN', 'TRANSFER_OUT', 'INTEREST', 'CREDIT', 'FEE', 'TAX', 'ADJUSTMENT'];
    for (const t of types) {
      expect(validateTransaction({ activityType: t }).activityType).toBe(t);
    }
  });

  it('rejects invalid currency codes', () => {
    expect(validateTransaction({ currency: 'us' }).currency).toBe('USD');
    expect(validateTransaction({ currency: 'TOOLONG' }).currency).toBe('USD');
    expect(validateTransaction({ currency: 'U1D' }).currency).toBe('USD');
  });

  it('accepts valid currency codes', () => {
    expect(validateTransaction({ currency: 'EUR' }).currency).toBe('EUR');
    expect(validateTransaction({ currency: 'GBP' }).currency).toBe('GBP');
    expect(validateTransaction({ currency: 'USDC' }).currency).toBe('USDC');
  });
});

// --- evaluateConfidence ---

describe('evaluateConfidence', () => {
  it('returns no flags for a healthy transaction', () => {
    expect(evaluateConfidence(makeTxn())).toEqual([]);
  });

  it('flags zero unit price on BUY/SELL', () => {
    const flags = evaluateConfidence(makeTxn({ unitPrice: 0 }));
    expect(flags).toContainEqual({ field: 'unitPrice', reason: 'Price is $0 for a trade' });
  });

  it('does not flag zero unit price on DIVIDEND', () => {
    const flags = evaluateConfidence(makeTxn({ activityType: 'DIVIDEND', unitPrice: 0 }));
    expect(flags.find(f => f.field === 'unitPrice')).toBeUndefined();
  });

  it('flags missing symbol', () => {
    const flags = evaluateConfidence(makeTxn({ symbol: '' }));
    expect(flags).toContainEqual({ field: 'symbol', reason: 'Missing symbol' });
  });

  it('flags missing date', () => {
    const flags = evaluateConfidence(makeTxn({ date: '' }));
    expect(flags).toContainEqual({ field: 'date', reason: 'Missing date' });
  });

  it('flags zero quantity on BUY/SELL', () => {
    const flags = evaluateConfidence(makeTxn({ quantity: 0 }));
    expect(flags).toContainEqual({ field: 'quantity', reason: 'Zero quantity for a trade' });
  });

  it('flags zero amount on BUY/SELL/DIVIDEND', () => {
    for (const activityType of ['BUY', 'SELL', 'DIVIDEND'] as const) {
      const flags = evaluateConfidence(makeTxn({ activityType, amount: 0 }));
      expect(flags).toContainEqual({ field: 'amount', reason: 'Zero amount' });
    }
  });

  it('does not flag zero amount on DEPOSIT', () => {
    const flags = evaluateConfidence(makeTxn({ activityType: 'DEPOSIT', amount: 0 }));
    expect(flags.find(f => f.reason === 'Zero amount')).toBeUndefined();
  });

  it('flags fee exceeding amount', () => {
    const flags = evaluateConfidence(makeTxn({ fee: 200, amount: 100 }));
    expect(flags).toContainEqual({ field: 'fee', reason: 'Fee exceeds transaction amount' });
  });

  it('does not flag fee exceeding amount when amount is 0', () => {
    const flags = evaluateConfidence(makeTxn({ fee: 10, amount: 0 }));
    expect(flags.find(f => f.field === 'fee')).toBeUndefined();
  });

  it('flags amount that diverges from qty × price by more than 1%', () => {
    // 10 × 150 = 1500, but amount is 2000 → 33% off
    const flags = evaluateConfidence(makeTxn({ quantity: 10, unitPrice: 150, amount: 2000 }));
    expect(flags).toContainEqual({ field: 'amount', reason: "Amount doesn't match quantity × price" });
  });

  it('does not flag amount within 1% tolerance', () => {
    // 10 × 150 = 1500, amount is 1505 → 0.33% off (within tolerance)
    const flags = evaluateConfidence(makeTxn({ quantity: 10, unitPrice: 150, amount: 1505 }));
    expect(flags.find(f => f.reason === "Amount doesn't match quantity × price")).toBeUndefined();
  });

  it('does not flag amount cross-validation on DIVIDEND', () => {
    const flags = evaluateConfidence(makeTxn({ activityType: 'DIVIDEND', quantity: 100, unitPrice: 0.5, amount: 200 }));
    expect(flags.find(f => f.reason === "Amount doesn't match quantity × price")).toBeUndefined();
  });

  it('skips cross-validation when quantity is zero', () => {
    const flags = evaluateConfidence(makeTxn({ quantity: 0, unitPrice: 150, amount: 1500 }));
    expect(flags.find(f => f.reason === "Amount doesn't match quantity × price")).toBeUndefined();
  });

  it('skips cross-validation when unitPrice is zero', () => {
    const flags = evaluateConfidence(makeTxn({ unitPrice: 0, quantity: 10, amount: 1500 }));
    expect(flags.find(f => f.reason === "Amount doesn't match quantity × price")).toBeUndefined();
  });

  it('skips cross-validation when amount is zero', () => {
    const flags = evaluateConfidence(makeTxn({ amount: 0, quantity: 10, unitPrice: 150 }));
    expect(flags.find(f => f.reason === "Amount doesn't match quantity × price")).toBeUndefined();
  });

  it('can return multiple flags at once', () => {
    const flags = evaluateConfidence(makeTxn({ symbol: '', date: '', unitPrice: 0 }));
    expect(flags.length).toBeGreaterThanOrEqual(3);
  });
});

// --- parseResponse ---

describe('parseResponse', () => {
  it('parses a bare JSON array', () => {
    const json = JSON.stringify([{
      date: '2025-01-01T00:00:00.000Z', symbol: 'AAPL', quantity: 1,
      activityType: 'BUY', unitPrice: 100, currency: 'USD', fee: 0, amount: 100,
    }]);
    const result = parseResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('AAPL');
  });

  it('parses a { transactions: [...] } wrapper', () => {
    const json = JSON.stringify({ transactions: [{
      date: '2025-01-01', symbol: 'MSFT', quantity: 5,
      activityType: 'SELL', unitPrice: 200, currency: 'USD', fee: 1, amount: 1000,
    }]});
    const result = parseResponse(json);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('MSFT');
  });

  it('strips markdown code fences', () => {
    const inner = JSON.stringify([{
      date: '2025-06-01', symbol: 'GOOG', quantity: 2,
      activityType: 'BUY', unitPrice: 150, currency: 'USD', fee: 0, amount: 300,
    }]);
    const wrapped = '```json\n' + inner + '\n```';
    const result = parseResponse(wrapped);
    expect(result).toHaveLength(1);
    expect(result[0].symbol).toBe('GOOG');
  });

  it('throws on empty/null/undefined input', () => {
    expect(() => parseResponse(null)).toThrow('Empty response');
    expect(() => parseResponse(undefined)).toThrow('Empty response');
    expect(() => parseResponse('')).toThrow('Empty response');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseResponse('not json')).toThrow('Could not parse');
  });

  it('throws on unexpected structure', () => {
    expect(() => parseResponse('{"data": 123}')).toThrow('Unexpected response structure');
    expect(() => parseResponse('"just a string"')).toThrow('Unexpected response structure');
  });

  it('returns empty array for empty transactions', () => {
    expect(parseResponse('[]')).toEqual([]);
    expect(parseResponse('{"transactions": []}')).toEqual([]);
  });

  it('validates each transaction in the array', () => {
    const json = JSON.stringify([
      { date: 'bad-date', symbol: 'AAPL', quantity: -1, activityType: 'BUY', unitPrice: 100, currency: 'USD', fee: 0, amount: 100 },
    ]);
    const result = parseResponse(json);
    expect(result[0].date).toBe('');
    expect(result[0].quantity).toBe(0);
  });
});

// --- buildSystemPrompt ---

describe('buildSystemPrompt', () => {
  it('includes the specified date format as an interpretation hint', () => {
    const prompt = buildSystemPrompt('MM/DD/YYYY');
    expect(prompt).toContain('Dates in the source document use MM/DD/YYYY ordering');
  });

  it('defaults to DD/MM/YYYY', () => {
    const prompt = buildSystemPrompt();
    expect(prompt).toContain('Dates in the source document use DD/MM/YYYY ordering');
  });

  it('includes YYYY-MM-DD when specified', () => {
    const prompt = buildSystemPrompt('YYYY-MM-DD');
    expect(prompt).toContain('Dates in the source document use YYYY-MM-DD ordering');
  });

  it('still requires ISO 8601 output format', () => {
    const prompt = buildSystemPrompt('DD/MM/YYYY');
    expect(prompt).toContain('ISO 8601 format');
  });

  it('default produces DD/MM/YYYY hint', () => {
    expect(buildSystemPrompt()).toContain('Dates in the source document use DD/MM/YYYY ordering');
  });
});

// --- Regex exports ---

describe('regex patterns', () => {
  it('ISO_DATE_RE matches valid dates', () => {
    expect(ISO_DATE_RE.test('2025-03-15')).toBe(true);
    expect(ISO_DATE_RE.test('2025-03-15T00:00:00.000Z')).toBe(true);
    expect(ISO_DATE_RE.test('2025-03-15T14:30:00Z')).toBe(true);
  });

  it('ISO_DATE_RE rejects invalid dates', () => {
    expect(ISO_DATE_RE.test('03/15/2025')).toBe(false);
    expect(ISO_DATE_RE.test('2025')).toBe(false);
    expect(ISO_DATE_RE.test('')).toBe(false);
  });

  it('SYMBOL_RE matches valid symbols', () => {
    expect(SYMBOL_RE.test('AAPL')).toBe(true);
    expect(SYMBOL_RE.test('$CASH-USD')).toBe(true);
    expect(SYMBOL_RE.test('')).toBe(true);
  });

  it('SYMBOL_RE rejects invalid symbols', () => {
    expect(SYMBOL_RE.test('A'.repeat(21))).toBe(false);
    expect(SYMBOL_RE.test('HAS SPACE')).toBe(false);
  });

  it('CURRENCY_RE matches valid currencies', () => {
    expect(CURRENCY_RE.test('USD')).toBe(true);
    expect(CURRENCY_RE.test('USDC')).toBe(true);
  });

  it('CURRENCY_RE rejects invalid currencies', () => {
    expect(CURRENCY_RE.test('us')).toBe(false);
    expect(CURRENCY_RE.test('TOOLONG')).toBe(false);
  });
});
