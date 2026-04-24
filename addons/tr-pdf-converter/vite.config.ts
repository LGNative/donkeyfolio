import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import externalGlobals from "rollup-plugin-external-globals";
import { defineConfig } from "vite";

/**
 * Inline vendor/ assets (HTML + CSS + 8 JS modules, fetched from the
 * /en/ variant of kontoauszug.jonathanpagel.com so the UI ships in
 * English) into a single self-contained HTML string. The addon renders
 * this via iframe + Blob URL at runtime. No external calls to the
 * original site are made once bundled — only to public CDNs (Tailwind,
 * pdf.js, Chart.js, feather-icons) that the tool itself loads.
 */
const vendorDir = path.resolve(__dirname, "vendor");
const jsFiles = [
  "utils.js",
  "statistics.js",
  "trading.js",
  "pricefeed.js",
  "parser.js",
  "ui.js",
  "export.js",
  "app.js",
];

function buildVendorHtml(): string {
  const indexHtml = fs.readFileSync(path.join(vendorDir, "index.html"), "utf8");
  const stylesCss = fs.readFileSync(path.join(vendorDir, "styles.css"), "utf8");
  const jsContents = jsFiles
    .map((f) => {
      const src = fs.readFileSync(path.join(vendorDir, "js", f), "utf8");
      return `\n// ─── ${f} ───\n${src}\n`;
    })
    .join("");

  let html = indexHtml;

  // Replace relative ../styles.css link with inline <style>.
  html = html.replace(
    /<link\s+rel="stylesheet"\s+href="\.\.\/styles\.css"\s*\/?>/,
    `<style>${stylesCss}</style>`,
  );

  // Strip all <script src="../js/...js"> references — we'll inject a single inline block.
  html = html.replace(/<script\s+src="\.\.\/js\/[^"]+\.js"\s+defer><\/script>\s*/g, "");

  // Strip tracking / upsell scripts (not needed in embedded use, user wants no hardcoded trackers).
  html = html.replace(/<script[^>]+umami[^>]+>\s*<\/script>/gi, "");
  html = html.replace(/<script[^>]+stripe[^>]+>\s*<\/script>/gi, "");
  html = html.replace(/<script[^>]+cloudflare-static[^>]*>\s*<\/script>/gi, "");

  // Inject the inlined JS right before </body>.
  html = html.replace("</body>", `<script>${jsContents}</script>\n</body>`);

  return html;
}

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __VENDOR_HTML__: JSON.stringify(buildVendorHtml()),
  },
  build: {
    lib: {
      entry: "src/addon.tsx",
      fileName: () => "addon.js",
      formats: ["es"],
    },
    rollupOptions: {
      external: ["react", "react-dom"],
      plugins: [
        externalGlobals({
          react: "React",
          "react-dom": "ReactDOM",
        }),
      ],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
        },
      },
    },
    outDir: "dist",
    minify: false,
    sourcemap: true,
  },
});
