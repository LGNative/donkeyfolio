import { useQuery } from "@tanstack/react-query";
import { type AddonContext, type Goal, QueryKeys } from "@wealthfolio/addon-sdk";
import { toFiniteAmount } from "../lib/utils";

interface UseGoalsOptions {
  ctx: AddonContext;
  enabled?: boolean;
}

function normalizeOptionalAmount(value: unknown) {
  if (value === null || value === undefined) {
    return undefined;
  }

  return toFiniteAmount(value);
}

export function useGoals({ ctx, enabled = true }: UseGoalsOptions) {
  return useQuery<Goal[]>({
    queryKey: [QueryKeys.GOALS],
    queryFn: async () => {
      if (!ctx.api) {
        throw new Error("API context is required");
      }

      const data = await ctx.api.goals.getAll();
      return (data || []).map((goal) => ({
        ...goal,
        targetAmount: toFiniteAmount(goal.targetAmount),
        summaryTargetAmount: normalizeOptionalAmount(goal.summaryTargetAmount),
        summaryCurrentValue: normalizeOptionalAmount(goal.summaryCurrentValue),
        summaryProgress: normalizeOptionalAmount(goal.summaryProgress),
      }));
    },
    enabled: enabled && !!ctx.api,
    staleTime: 10 * 60 * 1000, // 10 minutes
    gcTime: 30 * 60 * 1000, // 30 minutes
    retry: 3,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  });
}
