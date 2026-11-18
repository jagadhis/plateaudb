// Builds the npm package into dist/:
//   index.js                the main-thread API, one ES module
//   host.worker.js          the worker, one self-contained ES module (engine glue inlined)
//   plateau_engine_bg.wasm  the engine
//   *.d.ts                  types
// index.js names the worker and the WASM file with `new URL("./...", import.meta.url)`, the form
// Vite, webpack 5, esbuild-based tools and plain browsers all resolve relative to the module, so
// a consumer needs no bundler config and no server headers.
//
// bun build.ts               runs wasm-pack first (needs the rustup toolchain, see AGENTS.md)
// bun build.ts --skip-wasm   uses crates/engine/pkg as it is

import { $ } from "bun";
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const dist = here("./dist/");
const pkg = here("../../crates/engine/pkg/");

if (!process.argv.includes("--skip-wasm")) {
  const sysroot = (await $`rustc --print sysroot`.nothrow().quiet().text()).trim();
  const toolchain = sysroot.includes("rustup") ? sysroot : `${process.env.HOME}/.rustup/toolchains/stable-aarch64-apple-darwin`;
  const PATH = `${toolchain}/bin:${process.env.HOME}/.cargo/bin:${process.env.PATH}`;
  await $`wasm-pack build ${here("../../crates/engine")} --target web --release`.env({ ...process.env, PATH });
}
if (!existsSync(`${pkg}plateau_engine_bg.wasm`)) throw new Error(`no engine build in ${pkg}; run without --skip-wasm`);

rmSync(dist, { recursive: true, force: true });

const main = await Bun.build({ entrypoints: [here("./src/index.ts")], outdir: dist, target: "browser", format: "esm" });
if (!main.success) throw new AggregateError(main.logs, "build of src/index.ts failed");

const worker = await Bun.build({
  entrypoints: [here("./src/host.worker.ts")],
  outdir: dist,
  target: "browser",
  format: "esm",
  plugins: [
    {
      name: "plateau-engine",
      setup(b) {
        b.onResolve({ filter: /^plateau-engine$/ }, () => ({ path: `${pkg}plateau_engine.js` }));
      },
    },
  ],
});
if (!worker.success) throw new AggregateError(worker.logs, "build of src/host.worker.ts failed");

// The source names the worker and the WASM by their in-repo paths; the package ships them next to
// index.js. Each must be replaced exactly once, or the build is wrong.
const indexJs = `${dist}index.js`;
let code = readFileSync(indexJs, "utf8");
for (const [from, to] of [
  ['new URL("../../../crates/engine/pkg/plateau_engine_bg.wasm", import.meta.url)', 'new URL("./plateau_engine_bg.wasm", import.meta.url)'],
  ['new URL("./host.worker.ts", import.meta.url)', 'new URL("./host.worker.js", import.meta.url)'],
] as const) {
  const n = code.split(from).length - 1;
  if (n !== 1) throw new Error(`expected ${from} once in index.js, found ${n}`);
  code = code.replace(from, to);
}
writeFileSync(indexJs, code);

// wasm-bindgen's default init names the WASM by its own URL; the worker gets a compiled Module
// from the main thread instead, so that code must not reach the output.
if (readFileSync(`${dist}host.worker.js`, "utf8").includes("import.meta.url")) throw new Error("host.worker.js refers to import.meta.url");

copyFileSync(`${pkg}plateau_engine_bg.wasm`, `${dist}plateau_engine_bg.wasm`);

await $`tsc -p ${here("./tsconfig.build.json")}`;

for (const f of ["index.js", "host.worker.js", "plateau_engine_bg.wasm", "index.d.ts"]) {
  console.log(`dist/${f}  ${(Bun.file(`${dist}${f}`).size / 1024).toFixed(1)} KiB`);
}
