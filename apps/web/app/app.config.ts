// Nuxt UI v4 theme. Use our custom "brand" color (defined in main.css via
// --color-brand-* @theme tokens) as primary so buttons/badges/etc. match our
// muted-amber accent rather than Tailwind's loud amber-500. Neutral stays
// on zinc which complements the warm-ink background.
export default defineAppConfig({
  ui: {
    colors: {
      primary: 'brand',
      neutral: 'zinc',
    },
  },
})
