/**
 * Find or create a dedicated "Trade Republic" account so TR PDF activities
 * don't mix with existing ones. Returns the account id.
 *
 * Uses the addon SDK — accounts.getAll + accounts.create.
 */
import type { AddonContext } from "@wealthfolio/addon-sdk";

const TR_ACCOUNT_NAME = "Trade Republic";
const TR_ACCOUNT_CURRENCY = "EUR";

export async function ensureTRAccount(ctx: AddonContext): Promise<{
  accountId: string;
  created: boolean;
  currency: string;
}> {
  const existing = await ctx.api.accounts.getAll();
  const match = existing.find((a) => a.name.trim().toLowerCase() === TR_ACCOUNT_NAME.toLowerCase());
  if (match) {
    return {
      accountId: match.id,
      created: false,
      currency: match.currency || TR_ACCOUNT_CURRENCY,
    };
  }

  // accounts.create is typed as `unknown` in the SDK; the desktop bridge
  // accepts a NewAccount-shaped object.
  const created = await ctx.api.accounts.create({
    name: TR_ACCOUNT_NAME,
    accountType: "SECURITIES",
    group: "Brokers",
    currency: TR_ACCOUNT_CURRENCY,
    isDefault: false,
    isActive: true,
    platformId: null,
    accountNumber: null,
  });

  return {
    accountId: created.id,
    created: true,
    currency: created.currency || TR_ACCOUNT_CURRENCY,
  };
}
