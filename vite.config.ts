import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const apiTarget =
  process.env.WOOZI_API_TARGET ??
  `http://127.0.0.1:${Number(process.env.WOOZI_API_PORT ?? "8787")}`;

export default defineConfig({
  plugins: [svelte()],
  root: "web",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Published next to the bundle, with the sourceMappingURL left in. A
    // browser only fetches a map while its developer tools are open, and the
    // source is public anyway; without it a production error is a column in a
    // 44-line file (#352).
    sourcemap: true,
    rollupOptions: {
      input: {
        main: "web/index.html",
        admin: "web/admin.html",
        docs: "web/docs.html",
      },
    },
  },
  server: {
    port: Number(process.env.WOOZI_WEB_PORT ?? "4317"),
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/API.md": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/docs": {
        target: apiTarget,
        changeOrigin: true,
      },
      "/schemas": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
});
