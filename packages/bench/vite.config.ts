import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

// Cross-origin isolation gives every browser its fine-grained performance.now(); it does not
// change storage behaviour. No engine uses SharedArrayBuffer.
const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

/** The head bootstrap in index.html names the worker scripts and plateau's WASM by their built
 * (hashed) file names, relative to the page. In dev the placeholders stay and the bootstrap does nothing. */
function bootstrapUrls(): Plugin {
  const find = (bundle: Record<string, { fileName: string }>, re: RegExp) => {
    const hit = Object.values(bundle).find((f) => re.test(f.fileName));
    if (!hit) throw new Error(`bootstrap: no built file matches ${re}`);
    return `./${hit.fileName}`;
  };
  return {
    name: "bootstrap-urls",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(html, ctx) {
        const bundle = ctx.bundle as unknown as Record<string, { fileName: string }>;
        return html
          .replace("__PLATEAU_WORKER__", find(bundle, /^assets\/plateau\.worker-[\w-]+\.js$/))
          .replaceAll("__PLATEAU_WASM__", find(bundle, /^assets\/plateau_engine_bg-[\w-]+\.wasm$/))
          .replace("__SQLITE_WORKER__", find(bundle, /^assets\/sqlite\.worker-[\w-]+\.js$/))
          .replace("__PLATEAU_IDB_WORKER__", find(bundle, /^assets\/host\.worker-[\w-]+\.js$/));
      },
    },
  };
}

/** Built assets carry a content hash in their names, so the preview server marks them immutable,
 * as a production host would; the browser then reuses them (and, in Chromium, the compiled WASM
 * code cached with them) without asking the server again. index.html stays `no-cache`.
 *
 * `/first-<id>/...` serves the same files as `/...`. Every URL is relative (`base: "./"`), so a page
 * loaded under a new prefix fetches every script and WASM file at a URL the browser has never
 * seen: a first-ever load, with empty HTTP and code caches, on the same origin and storage. */
function previewServing(): Plugin {
  return {
    name: "preview-serving",
    configurePreviewServer(server) {
      server.middlewares.use((req, res, next) => {
        req.url = req.url?.replace(/^\/first-[\d-]+(?=\/)/, "");
        if (req.url?.startsWith("/assets/")) {
          const set = res.setHeader.bind(res);
          res.setHeader = (name, value) => set(name, name.toLowerCase() === "cache-control" ? "public, max-age=31536000, immutable" : value);
          res.setHeader("Cache-Control", "");
        }
        next();
      });
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [bootstrapUrls(), previewServing()],
  resolve: {
    alias: {
      // The library from source, so a change to it needs no build; the published package is dist/.
      plateaudb: fileURLToPath(new URL("../../packages/plateau/src/index.ts", import.meta.url)),
      "plateau-engine": fileURLToPath(new URL("../../crates/engine/pkg/plateau_engine.js", import.meta.url)),
    },
  },
  server: { headers },
  preview: { headers },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { target: "es2022" },
});
