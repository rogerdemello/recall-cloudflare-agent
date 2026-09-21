import { defineConfig } from "vitest/config";

// A standalone config on purpose. Inheriting vite.config.ts would drag in the
// Cloudflare plugin and its `root: "src/client"`, so tests under ./test would
// never be discovered. Everything under test here is pure TypeScript.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
