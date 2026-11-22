import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const resolve = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("./src/shared"),
      "@main": resolve("./src/main"),
      "@renderer": resolve("./src/renderer"),
    },
  },
  test: {
    globals: true,
    maxWorkers: 2,
    testTimeout: 20_000,
    projects: [
      {
        extends: true,
        test: {
          name: "main",
          environment: "node",
          include: ["tests/main/**/*.test.ts", "tests/shared/**/*.test.ts"],
          benchmark: { include: ["tests/main/**/*.bench.ts"] },
        },
      },
      {
        extends: true,
        test: {
          name: "renderer",
          environment: "happy-dom",
          include: ["tests/renderer/**/*.test.{ts,tsx}"],
          benchmark: { include: ["tests/renderer/**/*.bench.ts"] },
        },
      },
    ],
  },
});
