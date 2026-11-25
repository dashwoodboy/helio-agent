import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      // The Solarman V5 protocol code has one source of truth in the backend.
      {
        find: /^@solarman\/(.*)\.js$/,
        replacement: path.resolve(import.meta.dirname, "../backend/src/solarman/$1.ts"),
      },
    ],
  },
  test: {
    environment: "node",
    testTimeout: 20000,
  },
});
