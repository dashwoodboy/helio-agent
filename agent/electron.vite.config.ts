import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

/** The Solarman protocol code is shared with the backend (single source of truth). */
const solarmanAlias = [
  {
    find: /^@solarman\/(.*)\.js$/,
    replacement: path.resolve(import.meta.dirname, "../backend/src/solarman/$1.ts"),
  },
];

/** Build-time default server; override with HELIO_SERVER_URL=... npm run dist */
const serverUrl = JSON.stringify(process.env.HELIO_SERVER_URL ?? "https://helio-power.eu");

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: solarmanAlias },
    define: { __HELIO_SERVER_URL__: serverUrl },
    build: {
      lib: { entry: "src/main/index.ts" },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      // Sandboxed preload scripts must be CommonJS.
      lib: { entry: "src/preload/index.ts", formats: ["cjs"] },
    },
  },
  renderer: {
    plugins: [react()],
    root: "src/renderer",
    build: {
      rollupOptions: { input: "src/renderer/index.html" },
    },
  },
});
