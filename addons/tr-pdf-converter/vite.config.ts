import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import externalGlobals from "rollup-plugin-external-globals";
import { defineConfig } from "vite";

// ─── Build-time bundle of vendor/ files ────────────────────────────────────
// Reads the jcmpagel source (HTML + CSS + JS) and injects a single
// self-contained HTML string into the addon bundle. This avoids runtime
// file loading and lets the iframe render via srcdoc.
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
  const jsContents = jsFiles.map((f) => {
    const src = fs.readFileSync(path.join(vendorDir, "js", f), "utf8");
    return `\n// ─── ${f} ───\n${src}\n`;
  });

  return indexHtml
    .replace('<link rel="stylesheet" href="styles.css" />', `<style>${stylesCss}</style>`)
    .replace(/<script src="js\/[^"]+" defer><\/script>\s*/g, "")
    .replace("</body>", `<script>${jsContents.join("")}</script>\n</body>`);
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
