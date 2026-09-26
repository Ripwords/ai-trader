import { createHash, timingSafeEqual } from 'node:crypto'
import type { H3Event } from 'h3'
import { createError, getRequestHeader } from 'h3'
import { internalBearer, secretProblem } from '../../utils/secrets'

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

/**
 * Guard for /internal/* routes — only callable from sibling containers
 * (the Python api) that share the INTERNAL_BEARER secret. Throws 401
 * if the bearer is missing or doesn't match, 500 if the configured bearer is
 * unset, too short or the published example (fail closed: these routes hand
 * out decrypted provider keys).
 */
export function requireInternalBearer(event: H3Event): void {
  // Compose injects NUXT_INTERNAL_BEARER (the Nuxt runtimeConfig convention);
  // the bare name only exists when explicitly forwarded.
  const expected = internalBearer()
  const problem = secretProblem('INTERNAL_BEARER', expected)
  if (problem || !expected) {
    console.error(`[internal] refusing request: ${problem}`)
    throw createError({ statusCode: 500, statusMessage: problem ?? 'INTERNAL_BEARER not configured' })
  }
  const got = getRequestHeader(event, 'authorization') ?? ''
  // Hashing first gives equal-length buffers, so the comparison leaks neither content nor length.
  if (!timingSafeEqual(digest(got), digest(`Bearer ${expected}`))) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
}
