import { defineNitroPlugin } from 'nitropack/runtime'
import { envImportMessage, importLlmEnvOnce } from '../lib/llm-env-import'

export default defineNitroPlugin(() => {
  if (!process.env.DATABASE_URL) return
  importLlmEnvOnce(process.env)
    .then((outcome) => {
      const message = envImportMessage(outcome)
      if (message) console.info(message)
    })
    .catch((err: unknown) => {
      console.error('[llm] env import failed; it will retry on the next boot', err)
    })
})
