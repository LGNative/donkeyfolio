import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";

import { ErrorBoundary } from "./components/error-boundary";
import TrImporterPage from "./pages/tr-converter-page";

const SIDEBAR_ID = "tr-importer";
const ROUTE = "/addons/tr-importer";

const enable: AddonEnableFunction = (context: AddonContext) => {
  context.api.logger.info("TR Importer enabling…");

  const added: Array<{ remove: () => void }> = [];

  try {
    const sidebarItem = context.sidebar.addItem({
      id: SIDEBAR_ID,
      label: "TR Importer",
      icon: <Icons.FileText className="h-5 w-5" />,
      route: ROUTE,
      order: 250,
    });
    added.push(sidebarItem);

    // v5.1.0 — ErrorBoundary wraps the whole page so a render-time crash
    // in any sub-tree doesn't take down the host. The boundary surfaces
    // the error message + a "Try again" button to recover state.
    const PageWithCtx = () => (
      <ErrorBoundary logger={context.api.logger} addonName="TR Importer">
        <TrImporterPage ctx={context} />
      </ErrorBoundary>
    );

    context.router.add({
      path: ROUTE,
      component: React.lazy(() =>
        Promise.resolve({
          default: PageWithCtx,
        }),
      ),
    });

    context.api.logger.info("[TR Importer] enabled");
  } catch (error) {
    context.api.logger.error(`Failed to enable TR Importer: ${(error as Error).message}`);
    added.forEach((item) => item.remove());
    throw error;
  }

  return {
    disable: () => {
      added.forEach((item) => item.remove());
      context.api.logger.info("TR Importer disabled");
    },
  };
};

export default enable;
