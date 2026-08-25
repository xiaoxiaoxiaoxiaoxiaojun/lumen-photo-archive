import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "github-site",
  base: process.env.GITHUB_PAGES_BASE || "/",
  publicDir: "../public",
  plugins: [react()],
  build: {
    outDir: "../github-dist",
    emptyOutDir: true,
  },
});
