import type { H3Event } from 'h3'
import { createError, getRequestHeader } from 'h3'

/**
 * Guard for /internal/* routes — only callable from sibling containers
 * (the Python api) that share the INTERNAL_BEARER secret. Throws 401
 * if the bearer is missing or doesn't match, 500 if the env var isn't
 * configured (fail closed).
 */
export function requireInternalBearer(event: H3Event): void {
  const expected = process.env.INTERNAL_BEARER
  if (!expected) {
    throw createError({ statusCode: 500, statusMessage: 'INTERNAL_BEARER not configured' })
  }
  const got = getRequestHeader(event, 'authorization')
  if (got !== `Bearer ${expected}`) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
