import type { H3Event } from 'h3'
import { createError, getRequestHeader } from 'h3'

/**
 * Guard for /internal/* routes — only callable from sibling containers
 * (the Python api) that share the INTERNAL_BEARER secret. Throws 401
 * if the bearer is missing or doesn't match, 500 if the env var isn't
 * configured (fail closed).
 */
export function requireInternalBearer(event: H3Event): void {
  // Web container's compose env injects this as ``NUXT_INTERNAL_BEARER``
  // (the Nuxt runtimeConfig convention); the bare name only exists when
  // explicitly forwarded. Accept either so the guard works in both setups
  // and matches the proxy route's lookup order.
  const expected = process.env.INTERNAL_BEARER ?? process.env.NUXT_INTERNAL_BEARER
  if (!expected) {
    throw createError({ statusCode: 500, statusMessage: 'INTERNAL_BEARER not configured' })
  }
  const got = getRequestHeader(event, 'authorization')
  if (got !== `Bearer ${expected}`) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
