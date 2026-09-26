import { defineNitroPlugin } from 'nitropack/runtime'
import { importLlmEnvOnce } from '../lib/llm-env-import'

export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return
  importLlmEnvOnce(process.env)
    .then((outcome) => {
      if (outcome === 'imported') {
        console.info('[llm] imported LLM_MODEL and *_API_KEY from the environment into Settings; remove them from .env')
      }
    })
    .catch((err: unknown) => {
      console.error('[llm] env import failed; it will retry on the next boot', err)
    })
})
