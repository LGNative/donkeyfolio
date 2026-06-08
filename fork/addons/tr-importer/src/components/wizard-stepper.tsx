/**
 * Linear stepper for multi-step wizards (v5.0.0).
 *
 * Visual indicator of which step the user is on, what's done, what's
 * still ahead. Used at the top of the Import flow.
 */
import { Icons } from "@wealthfolio/ui";
import React from "react";

export type StepState = "done" | "current" | "future";

export interface WizardStep {
  id: string;
  label: string;
  state: StepState;
}

export function WizardStepper({ steps }: { steps: WizardStep[] }): React.JSX.Element {
  return (
    <div className="flex items-center gap-2 px-1 py-1">
      {steps.map((s, i) => (
        <React.Fragment key={s.id}>
          <div className="flex items-center gap-2">
            <div
              className={
                "flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold transition-colors " +
                stepCircleClasses(s.state)
              }
            >
              {s.state === "done" ? <Icons.CheckCircle className="h-4 w-4" /> : i + 1}
            </div>
            <span
              className={"whitespace-nowrap text-sm transition-colors " + stepLabelClasses(s.state)}
            >
              {s.label}
            </span>
          </div>
          {i < steps.length - 1 && (
            <div
              className={
                "h-px flex-1 transition-colors " +
                (s.state === "done" ? "bg-success/40" : "bg-border")
              }
            />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function stepCircleClasses(state: StepState): string {
  switch (state) {
    case "done":
      return "bg-success/20 text-success";
    case "current":
      return "bg-primary text-primary-foreground";
    case "future":
      return "bg-muted text-muted-foreground";
  }
}

function stepLabelClasses(state: StepState): string {
  switch (state) {
    case "done":
      return "text-muted-foreground";
    case "current":
      return "font-medium text-foreground";
    case "future":
      return "text-muted-foreground/60";
  }
}
