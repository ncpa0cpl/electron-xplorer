import { defineConfig } from "vite";
import { vanillaJsxResolveConfig } from "./vite.shared.mts";

// https://vitejs.dev/config
export default defineConfig({
  ...vanillaJsxResolveConfig(),
});
