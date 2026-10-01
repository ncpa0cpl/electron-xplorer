import { defineConfig } from "vite";
import { vanillaJsxResolveConfig } from "./vite.shared";

// https://vitejs.dev/config
export default defineConfig({
  ...vanillaJsxResolveConfig(),
  build: {
    rollupOptions: {
      external: ["fs", "path", "os", "node:fs", "node:fs/promises"],
    },
  },
});
