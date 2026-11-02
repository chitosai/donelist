import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { getSupabaseConfig } from "./src/lib/supabaseConfig";

export default defineConfig(({ command, mode }) => {
  if (command === "build") {
    // Fail before emitting a bundle if this build's environment is unconfigured.
    getSupabaseConfig(loadEnv(mode, process.cwd(), "VITE_"));
  }

  return { plugins: [react()] };
});
