import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  // Nuxt 4's `~` is the app/ srcDir; components import utils through it.
  resolve: { alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) } },
  test: {
    // Eval specs are discovered but skip themselves unless EVAL_LLM=1, so the
    // default run stays fast and free while `EVAL_LLM=1 npx vitest run` works
    // without a separate config.
    include: ['tests/unit/**/*.test.ts', 'tests/eval/**/*.eval.test.ts'],
    // Golden-question evals call a real model over the network.
    testTimeout: process.env.EVAL_LLM === '1' ? 120_000 : 5_000,
    // Per-file overrides via `// @vitest-environment happy-dom` docblock.
    environment: 'node',
    setupFiles: ['tests/setup-nitro-globals.ts'],
  },
})
