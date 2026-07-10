import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function readPort(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: readPort(process.env.PORT, 5174),
    proxy: { "/api": process.env.API_PROXY_TARGET || "http://localhost:8090" },
  },
});
