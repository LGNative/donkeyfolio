#!/usr/bin/env node
/**
 * Generate apps/tauri/tauri.conf.json from tauri.conf.template.json.
 *
 * Reads env vars (loaded via .env.local / .env.example before invocation)
 * and substitutes ${DONKEYFOLIO_*} placeholders in the template.
 *
 * Usage:
 *   node --env-file=.env.example --env-file=.env.local scripts/gen-tauri-conf.mjs
 *
 * Fails hard if any placeholder is missing — there must be zero hardcoded
 * values in tauri.conf.json.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const templatePath = path.join(projectRoot, "apps/tauri/tauri.conf.template.json");
const outputPath = path.join(projectRoot, "apps/tauri/tauri.conf.json");

if (!existsSync(templatePath)) {
  console.error(`[gen-tauri-conf] Template not found: ${templatePath}`);
  process.exit(1);
}

const template = readFileSync(templatePath, "utf8");

// Match ${DONKEYFOLIO_SOMETHING} placeholders
const placeholderRegex = /\$\{(DONKEYFOLIO_[A-Z0-9_]+)\}/g;
const missing = [];

const output = template.replace(placeholderRegex, (_, varName) => {
  const value = process.env[varName];
  if (value === undefined || value === "") {
    missing.push(varName);
    return `__MISSING_${varName}__`;
  }
  // Escape double quotes for JSON safety (values come from env, might contain ")
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
});

if (missing.length > 0) {
  console.error(
    `[gen-tauri-conf] Missing env vars (set them in .env.local or .env.example):\n  - ${missing.join("\n  - ")}`,
  );
  process.exit(1);
}

writeFileSync(outputPath, output);
console.log(`[gen-tauri-conf] Generated ${path.relative(projectRoot, outputPath)}`);
