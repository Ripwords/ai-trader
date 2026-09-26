const MIN_SECRET_LENGTH = 32
const GENERATE = 'Generate one with `openssl rand -base64 32` and put it in .env.'

/**
 * Why a deployment secret is unusable, or null when it is fine. `.env.example`
 * ships `change-me…` placeholders, and a copied example value is public.
 */
export function secretProblem(name: string, value: string | undefined): string | null {
  if (!value) return `${name} is not set. ${GENERATE}`
  if (value.startsWith('change-me')) return `${name} is still the example value from .env.example. ${GENERATE}`
  if (value.length < MIN_SECRET_LENGTH) return `${name} is shorter than ${MIN_SECRET_LENGTH} characters. ${GENERATE}`
  return null
}

type Env = Record<string, string | undefined>

export function internalBearer(env: Env = process.env): string | undefined {
  return env.INTERNAL_BEARER || env.NUXT_INTERNAL_BEARER || undefined
}

/**
 * A set-but-weak secret is fatal at boot. An unset one only disables what
 * needs it (internal routes, stored keys), so a bare dev server still starts.
 */
export function checkDeploymentSecrets(env: Env): { fatal: string[]; missing: string[] } {
  const report = { fatal: [] as string[], missing: [] as string[] }
  const secrets = [['INTERNAL_BEARER', internalBearer(env)], ['ENCRYPTION_KEY', env.ENCRYPTION_KEY]] as const
  for (const [name, value] of secrets) {
    const problem = secretProblem(name, value)
    if (problem) (value ? report.fatal : report.missing).push(problem)
  }
  return report
}
