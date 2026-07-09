/**
 * ErrorBoundary (v5.1.0).
 *
 * Wraps the addon's root component so a render-time error in any
 * sub-tree doesn't crash the host app — Wealthfolio remains usable and
 * the user gets a clear message + retry path. Errors are logged via the
 * SDK logger so they surface in the host logs.
 *
 * Pattern adapted from the AI Importer addon (foliveira) — same
 * structure, different brand.
 */
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Icons,
} from "@wealthfolio/ui";
import type { AddonContext } from "@wealthfolio/addon-sdk";
import React, { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Pull the logger shape from AddonContext rather than importing LoggerAPI
 * directly — the SDK doesn't re-export the interface from its public
 * entrypoint, only via individual type files. Using ctx.api.logger keeps
 * us insulated from internal SDK reorganisations.
 */
type Logger = AddonContext["api"]["logger"];

interface Props {
  children: ReactNode;
  logger: Logger;
  /** Friendly addon name used in the error UI. */
  addonName?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "(no component stack)";
    this.props.logger.error(
      `[${this.props.addonName ?? "Addon"}] Render error: ${error.message}\n${componentStack}`,
    );
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <Card className="border-destructive/50 m-4 max-w-2xl">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Icons.AlertCircle className="text-destructive h-5 w-5" />
              {this.props.addonName ?? "Addon"} encountered an error
            </CardTitle>
            <CardDescription>
              The error has been logged. The rest of Donkeyfolio is unaffected — you can keep using
              the app. Click "Try again" to recover this addon, or restart Donkeyfolio if the
              problem persists.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="bg-muted/50 rounded-lg border p-3">
              <p className="font-mono text-sm">{this.state.error.message}</p>
            </div>
            <Button onClick={this.reset}>
              <Icons.Refresh className="mr-2 h-4 w-4" />
              Try again
            </Button>
          </CardContent>
        </Card>
      );
    }
    return this.props.children;
  }
}
