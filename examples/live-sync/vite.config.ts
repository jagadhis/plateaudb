import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  resolve: {
    alias: {
      // The library from source, so a change to it needs no build; the published package is dist/.
      plateaudb: fileURLToPath(new URL("../../packages/plateau/src/index.ts", import.meta.url)),
      "plateau-engine": fileURLToPath(new URL("../../crates/engine/pkg/plateau_engine.js", import.meta.url)),
    },
  },
  worker: { format: "es" },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true },
  logLevel: "warn",
});
