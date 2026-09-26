import { defineNitroPlugin } from 'nitropack/runtime'
import { checkDeploymentSecrets } from '../utils/secrets'

export default defineNitroPlugin(() => {
  const { fatal, missing } = checkDeploymentSecrets(process.env)
  for (const problem of missing) console.error(`[secrets] ${problem}`)
  if (fatal.length > 0) {
    throw new Error(`Refusing to start: ${fatal.join(' ')}`)
  }
})
