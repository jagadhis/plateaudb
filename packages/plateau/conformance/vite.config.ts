import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// PLATEAU_DIST=1 runs the pages against the built package in dist/ (bun run build first), the
// files npm consumers get, instead of src/.
const dist = process.env.PLATEAU_DIST === "1";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: [
      { find: "plateau-engine", replacement: fileURLToPath(new URL("../../../crates/engine/pkg/plateau_engine.js", import.meta.url)) },
      ...(dist ? [{ find: /^\.\.\/src\/index$/, replacement: fileURLToPath(new URL("../dist/index.js", import.meta.url)) }] : []),
    ],
  },
  server: { fs: { allow: [fileURLToPath(new URL("../../..", import.meta.url))] } },
  worker: { format: "es" },
  build: { target: "es2022" },
  logLevel: "warn",
});
