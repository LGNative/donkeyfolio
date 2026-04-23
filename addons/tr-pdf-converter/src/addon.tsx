import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";

// Injected at build time by vite.config.ts — full self-contained HTML of the
// TR PDF Converter (jcmpagel's source inlined: HTML + CSS + all JS files).
declare const __VENDOR_HTML__: string;

const SOURCE_REPO = "https://github.com/jcmpagel/Trade-Republic-CSV-Excel";
const SOURCE_SITE = "https://kontoauszug.jonathanpagel.com/en/";

function TrPdfConverterPage() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Attribution header */}
      <div className="border-b bg-slate-50 px-4 py-3 dark:bg-slate-900">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h1 className="text-xl font-semibold">Trade Republic PDF Converter</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              Convert your Trade Republic PDF statements to CSV / Excel / JSON with charts and
              analytics. Runs 100% locally — no uploads, no telemetry.
            </p>
            <p className="text-muted-foreground/80 mt-2 text-xs">
              <strong>Credits:</strong> built on{" "}
              <a
                href={SOURCE_SITE}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:no-underline"
              >
                kontoauszug.jonathanpagel.com
              </a>{" "}
              by{" "}
              <a
                href={SOURCE_REPO}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary underline hover:no-underline"
              >
                @jcmpagel
              </a>
              . All credit to the original author — this addon vendors his open-source code for
              personal use in Donkeyfolio.
            </p>
            <p className="text-muted-foreground/80 mt-2 text-xs">
              <strong>Workflow:</strong> drop your TR PDF below → click <em>CSV</em> to export →
              then go to <em>Activities → Import</em> in Donkeyfolio to load the transactions.
            </p>
          </div>
        </div>
      </div>

      {/* Embedded converter via iframe srcDoc (self-contained HTML bundled at build time) */}
      <div className="min-h-0 flex-1">
        <iframe
          srcDoc={__VENDOR_HTML__}
          title="Trade Republic PDF Converter"
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-downloads allow-forms allow-same-origin allow-popups"
          allow="clipboard-write"
        />
      </div>
    </div>
  );
}

const enable: AddonEnableFunction = (context: AddonContext) => {
  context.api.logger.info("📄 TR PDF Converter addon enabling...");

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

    context.router.add({
      path: "/addons/tr-pdf-converter",
      component: React.lazy(() =>
        Promise.resolve({
          default: TrPdfConverterPage,
        }),
      ),
    });

    context.api.logger.info("📄 TR PDF Converter addon enabled");
  } catch (error) {
    context.api.logger.error(`Failed to enable TR PDF Converter: ${(error as Error).message}`);
    added.forEach((item) => item.remove());
    throw error;
  }

  return () => {
    added.forEach((item) => item.remove());
    context.api.logger.info("📄 TR PDF Converter addon disabled");
  };
};

export default enable;
