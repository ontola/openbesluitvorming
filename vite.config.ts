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
    rollupOptions: {
      input: {
        main: "web/index.html",
        admin: "web/admin.html",
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
    },
  },
});
