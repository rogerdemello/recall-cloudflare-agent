import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";

export default defineConfig({
  // The chat UI lives here; index.html is the Vite entry.
  root: "src/client",
  build: {
    // The Cloudflare plugin writes one subdirectory per environment under this
    // path — `dist/client` for the static assets, `dist/recall_agent` for the
    // Worker bundle and its generated wrangler.json.
    outDir: "../../dist",
    emptyOutDir: true,
  },
  plugins: [
    cloudflare({ configPath: "../../wrangler.jsonc" }),
    // Handles TC39 decorator transforms and the agents:skills import hook.
    agents(),
  ],
});
