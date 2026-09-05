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
  // @nuxt/ui bundles @nuxtjs/color-mode, which defaults to `system`. Left
  // unset it put `class="light"` on <html>, so every Nuxt UI surface rendered
  // its light palette underneath our hand-rolled --ink-* one — most visibly
  // the chat composer, whose `bg-default/75` came out white.
  //
  // `preference` is only a default: the module's pre-paint script reads the
  // stored key first, so anyone who already loaded the app has `system` cached
  // and would stay light forever. Moving to a fresh storageKey retires those
  // values. There is no theme switcher and main.css defines only a dark
  // palette, so nothing will ever write a different one.
  colorMode: { preference: 'dark', fallback: 'dark', storageKey: 'ai-trader-color-mode' },
  app: {
    head: {
      title: 'ai·trader',
      titleTemplate: '%s · copilot',
      meta: [
        { name: 'description', content: 'Trading copilot — moomoo data, AI chat, charts, news, portfolio.' },
        { name: 'theme-color', content: '#0d0f12' },
        // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
        // anything but 0 on notched phones; interactive-widget keeps the chat
        // composer above the soft keyboard instead of behind it.
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content' },
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
