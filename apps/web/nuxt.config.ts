export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  devtools: { enabled: true },
  typescript: { strict: true },
  runtimeConfig: {
    appPassword: '',
    sessionSecret: '',
    internalBearer: '',
    apiBaseUrl: 'http://api:8000',
    public: {},
    // LLM provider keys, model id, and Tavily key are read directly from
    // process.env in agent.ts (Mastra's provider registry expects them
    // there anyway). Keeping them out of runtimeConfig avoids pulling
    // Mastra into the Nitro chunk graph during prod build.
  },
  nitro: { experimental: { websocket: true } },
})
