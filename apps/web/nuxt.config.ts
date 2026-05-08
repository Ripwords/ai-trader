export default defineNuxtConfig({
  modules: ['@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  // Disable path-prefix on auto-imported components so files like
  // app/components/chat/NewsCard.vue are reachable as <NewsCard>, not
  // <ChatNewsCard>. Names are unique enough across our app.
  components: [
    { path: '~/components', pathPrefix: false },
  ],
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
