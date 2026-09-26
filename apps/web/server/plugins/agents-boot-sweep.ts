import { defineNitroPlugin } from 'nitropack/runtime'
import { failInterruptedRuns } from '../lib/agents/start-run'

export default defineNitroPlugin(() => {
  failInterruptedRuns(new Date()).catch((e: unknown) => {
    console.error('[agents] boot sweep failed', (e as Error)?.message)
  })
})
