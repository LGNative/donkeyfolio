export const ACTIVITY_TYPES = [
  'BUY',
  'SELL',
  'SPLIT',
  'DIVIDEND',
  'DEPOSIT',
  'WITHDRAWAL',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'INTEREST',
  'CREDIT',
  'FEE',
  'TAX',
  'ADJUSTMENT',
] as const;

export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export interface ExtractedTransaction {
  date: string;
  symbol: string;
  quantity: number;
  activityType: ActivityType;
  unitPrice: number;
  currency: string;
  fee: number;
  amount: number;
}

export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const;
export type DateFormat = (typeof DATE_FORMATS)[number];

export function buildSystemPrompt(dateFormat: DateFormat = 'DD/MM/YYYY'): string {
  return `You are a financial document parser. Extract all investment transactions from the provided document image(s). Return ONLY valid JSON.

Each transaction must have these fields:
- date: ISO 8601 format (YYYY-MM-DDTHH:mm:ss.000Z). Use midnight if time is unknown.
- symbol: Ticker symbol (e.g., MSFT, AAPL). Use $CASH-{CURRENCY} for cash transactions (e.g., $CASH-USD).
- quantity: Number of shares/units. Use 1 for cash activities.
- activityType: One of: ${ACTIVITY_TYPES.join(', ')}
- unitPrice: Price per share/unit. Use 1 for cash activities.
- currency: ISO 4217 code (USD, EUR, GBP, etc.)
- fee: Transaction fee. Use 0 if none or unknown.
- amount: Total amount. For BUY/SELL: quantity × unitPrice. For cash activities: the cash amount.

Rules:
- Dates in the source document use ${dateFormat} ordering. Interpret ambiguous dates accordingly.
- Only extract actual transactions, NOT summaries, balances, or totals.
- If a transaction type does not match any activityType exactly, choose the closest match.
- If you cannot determine a field, use a reasonable default.
- Return an empty array [] if no transactions are found.`;
}

export const USER_PROMPT = 'Extract all investment transactions from this document.';

export const TRANSACTION_SCHEMA = {
  type: 'object',
  properties: {
    transactions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'ISO 8601 date (YYYY-MM-DDTHH:mm:ss.000Z). Use midnight if time is unknown.' },
          symbol: { type: 'string', description: 'Ticker symbol (e.g., MSFT, AAPL). Use $CASH-{CURRENCY} for cash transactions.' },
          quantity: { type: 'number', description: 'Number of shares/units. Use 1 for cash activities.' },
          activityType: { type: 'string', enum: [...ACTIVITY_TYPES], description: 'Transaction type. Choose the closest match.' },
          unitPrice: { type: 'number', description: 'Price per share/unit. Use 1 for cash activities.' },
          currency: { type: 'string', description: 'ISO 4217 currency code (USD, EUR, GBP, etc.).' },
          fee: { type: 'number', description: 'Transaction fee. Use 0 if none or unknown.' },
          amount: { type: 'number', description: 'Total amount. For BUY/SELL: quantity × unitPrice.' },
        },
        required: ['date', 'symbol', 'quantity', 'activityType', 'unitPrice', 'currency', 'fee', 'amount'],
        additionalProperties: false,
      },
    },
  },
  required: ['transactions'],
  additionalProperties: false,
} as const;
