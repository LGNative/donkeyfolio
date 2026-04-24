import react from "@vitejs/plugin-react";
import externalGlobals from "rollup-plugin-external-globals";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
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
        // Inline everything (including pdfjs-dist) into one addon.js file.
        inlineDynamicImports: true,
      },
    },
    outDir: "dist",
    minify: false,
    sourcemap: false,
  },
});
