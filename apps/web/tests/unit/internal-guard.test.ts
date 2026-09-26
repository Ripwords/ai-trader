import type { H3Event } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { requireInternalBearer } from '../../server/api/internal/_guard'
import { checkDeploymentSecrets, secretProblem } from '../../server/utils/secrets'

const STRONG = 'b'.repeat(40)

function makeEvent(headers: Record<string, string> = {}): H3Event {
  return { node: { req: { headers } }, context: {}, path: '/' } as unknown as H3Event
}

function statusOf(fn: () => void): number | undefined {
  try {
    fn()
    return undefined
  }
  catch (err) {
    return (err as { statusCode?: number }).statusCode
  }
}

const saved = { bare: process.env.INTERNAL_BEARER, nuxt: process.env.NUXT_INTERNAL_BEARER }
afterEach(() => {
  for (const [name, value] of [['INTERNAL_BEARER', saved.bare], ['NUXT_INTERNAL_BEARER', saved.nuxt]] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

describe('secretProblem', () => {
  it('accepts a long random value', () => {
    expect(secretProblem('INTERNAL_BEARER', STRONG)).toBeNull()
  })

  it('names the variable and the fix for unset, example and short values', () => {
    for (const value of [undefined, '', 'change-me-internal-bearer', 'change-me-run-openssl-rand-base64-32-and-more', 'short']) {
      const problem = secretProblem('INTERNAL_BEARER', value)
      expect(problem, String(value)).toMatch(/INTERNAL_BEARER/)
      expect(problem).toMatch(/openssl rand/)
    }
  })
})

describe('requireInternalBearer', () => {
  it('accepts the configured bearer', () => {
    process.env.INTERNAL_BEARER = STRONG
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: `Bearer ${STRONG}` })))).toBeUndefined()
  })

  it('reads NUXT_INTERNAL_BEARER when the bare name is absent', () => {
    delete process.env.INTERNAL_BEARER
    process.env.NUXT_INTERNAL_BEARER = STRONG
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: `Bearer ${STRONG}` })))).toBeUndefined()
  })

  it('rejects a wrong, missing or differently sized bearer', () => {
    process.env.INTERNAL_BEARER = STRONG
    expect(statusOf(() => requireInternalBearer(makeEvent()))).toBe(401)
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: `Bearer ${'c'.repeat(40)}` })))).toBe(401)
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: `Bearer ${STRONG}x` })))).toBe(401)
  })

  it('refuses to serve with the example bearer even when the caller sends it', () => {
    process.env.INTERNAL_BEARER = 'change-me-internal-bearer'
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: 'Bearer change-me-internal-bearer' })))).toBe(500)
  })

  it('refuses to serve with a short or unset bearer', () => {
    process.env.INTERNAL_BEARER = 'test-bearer'
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: 'Bearer test-bearer' })))).toBe(500)
    delete process.env.INTERNAL_BEARER
    delete process.env.NUXT_INTERNAL_BEARER
    expect(statusOf(() => requireInternalBearer(makeEvent({ authorization: 'Bearer ' })))).toBe(500)
  })
})

describe('checkDeploymentSecrets', () => {
  it('passes strong secrets', () => {
    expect(checkDeploymentSecrets({ INTERNAL_BEARER: STRONG, ENCRYPTION_KEY: STRONG })).toEqual({ fatal: [], missing: [] })
  })

  it('treats a set but weak secret as fatal and an unset one as missing', () => {
    const report = checkDeploymentSecrets({ NUXT_INTERNAL_BEARER: 'change-me-internal-bearer' })
    expect(report.fatal).toEqual([expect.stringMatching(/INTERNAL_BEARER is still the example value/)])
    expect(report.missing).toEqual([expect.stringMatching(/ENCRYPTION_KEY is not set/)])
    expect(checkDeploymentSecrets({ INTERNAL_BEARER: STRONG, ENCRYPTION_KEY: 'short' }).fatal)
      .toEqual([expect.stringMatching(/ENCRYPTION_KEY is shorter than 32/)])
  })
})
