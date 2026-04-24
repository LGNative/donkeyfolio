import type { AddonContext, AddonEnableFunction } from "@wealthfolio/addon-sdk";
import { Icons } from "@wealthfolio/ui";
import React from "react";

// Injected at build time by vite.config.ts — full self-contained English
// HTML bundle (from /en/ on kontoauszug.jonathanpagel.com + vendored JS).
// Tracking/upsell scripts are stripped during build.
declare const __VENDOR_HTML__: string;

const SOURCE_REPO = "https://github.com/jcmpagel/Trade-Republic-CSV-Excel";
const SOURCE_SITE = "https://kontoauszug.jonathanpagel.com/en/";

function TrPdfConverterPage() {
  // Create a Blob URL once per mount — no external fetch at runtime.
  // Blob URL avoids srcdoc size limits and allows the iframe to act like a
  // normal same-origin-ish document (internal relative navigation works).
  const iframeSrc = React.useMemo(() => {
    const blob = new Blob([__VENDOR_HTML__], { type: "text/html" });
    return URL.createObjectURL(blob);
  }, []);

  React.useEffect(() => {
    return () => URL.revokeObjectURL(iframeSrc);
  }, [iframeSrc]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="min-h-0 flex-1">
        <iframe
          src={iframeSrc}
          title="Trade Republic PDF Converter"
          className="h-full w-full border-0"
          sandbox="allow-scripts allow-downloads allow-forms allow-same-origin allow-popups"
          allow="clipboard-write"
          style={{ colorScheme: "light" }}
        />
      </div>

      <div className="border-t border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600">
        <span>
          Built on{" "}
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
          </a>{" "}
          · after exporting CSV, go to <em>Activities → Import</em> in Donkeyfolio.
        </span>
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

  return {
    disable: () => {
      added.forEach((item) => item.remove());
      context.api.logger.info("📄 TR PDF Converter addon disabled");
    },
  };
};

export default enable;
