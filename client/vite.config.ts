import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const DEV_PORT = Number(process.env.MACDASH_DEV_PORT) || 7228;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    // The one place that names the dev port. 5173 is Vite's default and collides with other projects.
    port: DEV_PORT,
    strictPort: true,
    fs: { allow: [".."] }, // shared/ lives next to client/
    proxy: {
      "/api": {
        target: "http://localhost:7227",
        changeOrigin: true,
      },
      "/ws": {
        target: "http://localhost:7227",
        ws: true,
      },
    },
  },
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
  },
});
