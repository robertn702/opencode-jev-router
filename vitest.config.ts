import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Lets tests force GC to check that cancellation survives weakly held abort links.
    execArgv: ["--expose-gc"],
  },
});
