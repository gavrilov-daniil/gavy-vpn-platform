import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3200,
    proxy: {
      "/api": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
      // тарифы отдаются публичным API core, а не под /api
      "/v1": {
        target: "http://localhost:3100",
        changeOrigin: true,
      },
    },
  },
});
