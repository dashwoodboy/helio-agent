// Bundle the headless CLI (src/cli) into one node-runnable file for servers:
// release/helio-agent-cli.cjs — run it with node >= 20, no npm install needed.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const solarmanDir = path.resolve(root, "../backend/src/solarman");

await build({
  entryPoints: [path.join(root, "src/cli/index.ts")],
  outfile: path.join(root, "release/helio-agent-cli.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  define: {
    __HELIO_SERVER_URL__: JSON.stringify(process.env.HELIO_SERVER_URL ?? "https://helio-power.eu"),
  },
  // ws's optional native accelerators; it falls back to pure JS without them.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
  plugins: [
    {
      name: "ts-js-specifiers",
      setup(b) {
        // The sources use NodeNext-style ".js" specifiers for ".ts" files,
        // and "@solarman/*" points at the backend's Solarman module.
        b.onResolve({ filter: /^@solarman\/.*\.js$/ }, (args) => ({
          path: path.join(solarmanDir, args.path.slice("@solarman/".length).replace(/\.js$/, ".ts")),
        }));
        b.onResolve({ filter: /^\..*\.js$/ }, (args) => {
          const ts = path.resolve(args.resolveDir, args.path.replace(/\.js$/, ".ts"));
          return fs.existsSync(ts) ? { path: ts } : null;
        });
      },
    },
  ],
});

fs.chmodSync(path.join(root, "release/helio-agent-cli.cjs"), 0o755);
console.log("CLI bundle ready: release/helio-agent-cli.cjs");
