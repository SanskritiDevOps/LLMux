import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  // VITE_API_URL is baked in at build time. Without it a deployed dashboard would call
  // localhost, so a production build fails instead.
  if (command === "build" && mode === "production") {
    const { VITE_API_URL } = loadEnv(mode, import.meta.dirname, "VITE_");
    if (!VITE_API_URL) {
      throw new Error("VITE_API_URL must be set for a production build (the API's URL).");
    }
  }

  return { plugins: [react(), tailwindcss()] };
});
