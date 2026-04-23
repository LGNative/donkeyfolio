import React, { Component, type ErrorInfo, type ReactNode } from 'react';
import type { HostAPI } from '../types';

interface Props {
  children: ReactNode;
  logger: HostAPI['logger'];
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.logger.error(`[AI Importer] Render error: ${error.message}\n${info.componentStack}`);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '24px', textAlign: 'center' }}>
          <p style={{ fontWeight: 500, color: 'hsl(0 84% 60%)' }}>AI Importer encountered an error.</p>
          <p style={{ fontSize: '13px', color: 'var(--muted-foreground)' }}>{this.state.error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            style={{ marginTop: '12px', padding: '6px 16px', borderRadius: '6px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--foreground)', cursor: 'pointer', fontSize: '13px' }}
          >
            Try Again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
