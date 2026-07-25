import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // testes tocam disco (sandbox temporaria por teste) e subprocessos reais
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
