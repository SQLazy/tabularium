import { defineConfig } from "vitest/config";

// Root tests only. mcp/ is its own package and runs its tests with `node --test`.
export default defineConfig({ test: { include: ["test/**/*.test.{ts,mjs}"] } });
