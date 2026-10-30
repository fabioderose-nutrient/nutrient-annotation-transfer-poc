import { defineConfig } from "vite";

// The Nutrient Web SDK is loaded from its CDN in index.html, so Vite only bundles the
// application code. The samples in public/ are copied to the build as they are.
export default defineConfig({
  build: {
    sourcemap: true,
  },
  server: {
    port: Number(process.env.PORT) || 5181,
  },
  preview: {
    port: Number(process.env.PORT) || 5181,
  },
});
