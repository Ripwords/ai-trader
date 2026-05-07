export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },
  typescript: { strict: true },
  runtimeConfig: {
    appPassword: '',
    sessionSecret: '',
    internalBearer: '',
    apiBaseUrl: 'http://api:8000',
    anthropicApiKey: '',
    llmModel: 'claude-sonnet-4-6',
    public: {},
  },
  nitro: { experimental: { websocket: true } },
})
