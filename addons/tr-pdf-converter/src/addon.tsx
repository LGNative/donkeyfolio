import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";

import TrConverterPage from "./pages/tr-converter-page";

const enable: AddonEnableFunction = (context: AddonContext) => {
  context.api.logger.info("📄 TR PDF Converter (native) enabling...");

  const added: Array<{ remove: () => void }> = [];

  try {
    const sidebarItem = context.sidebar.addItem({
      id: "tr-pdf-converter",
      label: "TR PDF Converter",
      icon: <Icons.FileText className="h-5 w-5" />,
      route: "/addons/tr-pdf-converter",
      order: 250,
    });
    added.push(sidebarItem);

    // Capture the context in a closure so the page can call back into the
    // host SDK (accounts.getAll, accounts.create, activities.import, …).
    const PageWithCtx = () => <TrConverterPage ctx={context} />;

    context.router.add({
      path: "/addons/tr-pdf-converter",
      component: React.lazy(() =>
        Promise.resolve({
          default: PageWithCtx,
        }),
      ),
    });

    context.api.logger.info("📄 TR PDF Converter enabled (v2.2 native)");
  } catch (error) {
    context.api.logger.error(`Failed to enable TR PDF Converter: ${(error as Error).message}`);
    added.forEach((item) => item.remove());
    throw error;
  }

  return {
    disable: () => {
      added.forEach((item) => item.remove());
      context.api.logger.info("📄 TR PDF Converter disabled");
    },
  };
};

export default enable;
