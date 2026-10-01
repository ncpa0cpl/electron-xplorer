import { defineConfig } from "vite";
import { vanillaJsxResolveConfig } from "./vite.shared.mts";

// https://vitejs.dev/config
export default defineConfig({
  ...vanillaJsxResolveConfig(),
  build: {
    rollupOptions: {
      external: ["fs", "path", "os", "node:fs", "node:fs/promises"],
    },
  },
});
