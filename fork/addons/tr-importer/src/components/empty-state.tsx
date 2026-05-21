/**
 * Reusable empty state component (v5.0.0).
 *
 * Used wherever a tab/panel has no data to show — instead of a silent zero,
 * we explain why the data is missing and give the user a clear CTA to
 * resolve it. Pattern from Nielsen Norman: empty states should always
 * teach the user what to do next, never appear as a broken state.
 */
import { Button, Card, CardContent } from "@wealthfolio/ui";
import React from "react";

interface Props {
  icon: React.ReactNode;
  title: string;
  description: string;
  primaryAction?: {
    label: string;
    onClick: () => void;
    icon?: React.ReactNode;
  };
  secondaryAction?: {
    label: string;
    onClick: () => void;
  };
}

export function EmptyState({
  icon,
  title,
  description,
  primaryAction,
  secondaryAction,
}: Props): React.JSX.Element {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="bg-muted/30 flex h-16 w-16 items-center justify-center rounded-2xl">
          {icon}
        </div>
        <div className="max-w-md space-y-2">
          <h3 className="text-base font-semibold">{title}</h3>
          <p className="text-muted-foreground text-sm">{description}</p>
        </div>
        {(primaryAction || secondaryAction) && (
          <div className="mt-2 flex gap-2">
            {primaryAction && (
              <Button onClick={primaryAction.onClick} size="default">
                {primaryAction.icon && <span className="mr-2">{primaryAction.icon}</span>}
                {primaryAction.label}
              </Button>
            )}
            {secondaryAction && (
              <Button variant="outline" onClick={secondaryAction.onClick} size="default">
                {secondaryAction.label}
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
