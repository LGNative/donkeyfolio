#!/usr/bin/env node
/**
 * Wrapper around tauri CLI that:
 *   1. Loads .env.example and .env.local into process.env (local overrides)
 *   2. Generates apps/tauri/tauri.conf.json from the template
 *   3. Spawns `tauri` with the user's args, inheriting env so cargo/rustc
 *      also see DONKEYFOLIO_* vars via option_env!().
 *
 * This keeps zero hardcoded secrets/URLs in the repo — everything flows
 * from .env.local.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ─── Simple .env loader (no runtime dependency) ─────────────────────────
function loadEnv(filePath) {
  if (!existsSync(filePath)) return 0;
  const text = readFileSync(filePath, "utf8");
  let count = 0;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    // Shell-style $HOME expansion
    value = value.replace(/\$HOME\b/g, process.env.HOME ?? "");
    if (!(key in process.env)) {
      process.env[key] = value;
      count++;
    }
  }
  return count;
}

// Load order: .env.local first (highest precedence), .env.example fallback.
// .env.local is gitignored — contains local/fork-specific values that
// must override the example/defaults committed to the repo.
const loaded2 = loadEnv(path.join(projectRoot, ".env.local"));
const loaded1 = loadEnv(path.join(projectRoot, ".env.example"));
console.log(`[tauri-wrapper] Loaded env: .env.example=${loaded1}, .env.local=${loaded2}`);

// ─── Generate tauri.conf.json from template ─────────────────────────────
const genResult = await new Promise((resolve) => {
  const p = spawn(process.execPath, [path.join(__dirname, "gen-tauri-conf.mjs")], {
    stdio: "inherit",
    env: process.env,
  });
  p.on("exit", resolve);
});
if (genResult !== 0) {
  console.error("[tauri-wrapper] gen-tauri-conf.mjs failed");
  process.exit(genResult ?? 1);
}

// ─── Spawn tauri with inherited env ─────────────────────────────────────
const args = process.argv.slice(2);

// `tauri-action@v0` calls `pnpm tauri init --ci` before the build to
// auto-scaffold a config when the project doesn't have one. For us, that
// overwrites the tauri.conf.json we JUST generated from the template
// with empty defaults ({productName:"", version:""}), then the build
// fails with "Could not determine package name and version".
//
// We already have a fully-populated tauri.conf.json from the template
// generation step above, so this `init` call is destructive. Treat it
// as a no-op.
if (args[0] === "init") {
  console.log("[tauri-wrapper] Skipping `tauri init` — config already generated from template.");
  process.exit(0);
}

const tauriBin = path.join(projectRoot, "node_modules/.bin/tauri");
const actualBin = existsSync(tauriBin) ? tauriBin : "tauri";

const child = spawn(actualBin, args, {
  stdio: "inherit",
  env: process.env,
  cwd: projectRoot,
});

child.on("exit", (code) => process.exit(code ?? 0));
