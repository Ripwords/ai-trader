import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // Per-file overrides via `// @vitest-environment happy-dom` docblock.
    environment: 'node',
  },
})
