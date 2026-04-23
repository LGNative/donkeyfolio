import React from 'react';
import type { AddonContext } from './types';
import { ImporterPage } from './components/ImporterPage';
import { ErrorBoundary } from './components/ErrorBoundary';

export default function enable(ctx: AddonContext) {
  const sidebarItem = ctx.sidebar.addItem({
    id: 'ai-importer',
    icon: <span style={{ fontSize: '18px' }}>📄</span>,
    label: 'AI Importer',
    route: '/addon/ai-importer',
  });

  const PageComponent = () => (
    <ErrorBoundary logger={ctx.api.logger}>
      <ImporterPage ctx={ctx} />
    </ErrorBoundary>
  );

  ctx.router.add({
    path: '/addon/ai-importer',
    component: React.lazy(() =>
      Promise.resolve({ default: PageComponent })
    ),
  });

  ctx.onDisable(() => {
    sidebarItem.remove();
  });
}
