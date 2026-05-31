import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": "http://localhost:8787",
      "/otlp": "http://localhost:8787",
      "/events": "http://localhost:8787"
    }
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: false
  }
});
