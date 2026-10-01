import { defineConfig } from "vite";
import { vanillaJsxResolveConfig } from "./vite.shared";

// https://vitejs.dev/config
export default defineConfig({
  ...vanillaJsxResolveConfig(),
});
