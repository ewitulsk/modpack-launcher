import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// @remix/core is a workspace package: bundle it into main instead of shipping it as a dependency.
const externalizeDeps = { exclude: ["@remix/core"] };

export default defineConfig({
  main: {
    build: { externalizeDeps, rollupOptions: { input: resolve(__dirname, "src/main/index.ts") } },
  },
  preload: {
    build: { externalizeDeps, rollupOptions: { input: resolve(__dirname, "src/preload/index.ts") } },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: { rollupOptions: { input: resolve(__dirname, "src/renderer/index.html") } },
    plugins: [react()],
  },
});
