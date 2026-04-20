import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";

// API server URL — override with VITE_API_URL env var in production
const API_URL = process.env.VITE_API_URL || "http://localhost:3001";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 3000,
    proxy: {
      // Proxy all /api requests to the Fastify backend in development.
      // In production, nginx handles this (see docker/nginx.conf).
      "/api": {
        target: API_URL,
        changeOrigin: true,
        // Don't rewrite — the API already registers routes at /api/v1/*
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
