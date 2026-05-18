import { createError, defineEventHandler, getQuery } from 'h3'
import { resolveSymbol } from '../../../lib/yahoo'
import { requireInternalBearer } from '../_guard'

// Canonical-symbol resolver. Single source of truth every service resolves
// through — see docs/superpowers/specs/2026-05-18-canonical-ticker-resolution-design.md.
export default defineEventHandler(async (event) => {
  requireInternalBearer(event)
  const { q } = getQuery(event)
  if (typeof q !== 'string' || !q.trim()) {
    throw createError({ statusCode: 400, statusMessage: 'q required' })
  }
  return await resolveSymbol(q)
})
