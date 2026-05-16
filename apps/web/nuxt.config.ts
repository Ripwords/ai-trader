export default defineNuxtConfig({
  modules: ['@nuxt/ui', '@comark/nuxt'],
  css: ['~/assets/css/main.css'],
  // Disable path-prefix on auto-imported components so files like
  // app/components/chat/NewsCard.vue are reachable as <NewsCard>, not
  // <ChatNewsCard>. Names are unique enough across our app.
  components: [
    { path: '~/components', pathPrefix: false },
  ],
  // Devtools floating button clutters the composer area — turn it off.
  devtools: { enabled: false },
  typescript: { strict: true },
  app: {
    head: {
      title: 'ai·trader',
      titleTemplate: '%s · copilot',
      meta: [
        { name: 'description', content: 'Trading copilot — moomoo data, AI chat, charts, news, portfolio.' },
        { name: 'theme-color', content: '#0d0f12' },
      ],
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'mask-icon', href: '/icon-mark.svg', color: '#d4a96a' },
      ],
    },
  },
  runtimeConfig: {
    appPassword: '',
    sessionSecret: '',
    internalBearer: '',
    apiBaseUrl: 'http://api:8000',
    public: {
      // Echoed to the chat footer. Mirrors process.env.LLM_MODEL via NUXT_PUBLIC_LLM_MODEL.
      llmModel: '',
    },
    // LLM provider keys, model id, and Tavily key are read directly from
    // process.env in the chat/LLM layer. Keeping them out of runtimeConfig
    // keeps provider SDKs out of the Nitro client chunk graph.
  },
  nitro: { experimental: { websocket: true } },
})
