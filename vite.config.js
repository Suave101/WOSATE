import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Z3's threaded WebAssembly needs a cross-origin isolated page. The dev and
// preview servers send the headers directly; on GitHub Pages
// public/coi-serviceworker.js adds them instead.
const isolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Relative base so the build works at https://<user>.github.io/<repo>/.
  base: "./",
  plugins: [react()],
  server: { host: "127.0.0.1", port: Number(process.env.PORT) || 8080, strictPort: true, headers: isolation },
  preview: { headers: isolation },
  build: { outDir: "dist", target: "es2022" },
});
