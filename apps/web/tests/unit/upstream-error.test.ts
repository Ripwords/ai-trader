import { describe, expect, it } from 'vitest'
import { upstreamError } from '../../server/utils/upstream-error'

describe('upstreamError', () => {
  it('keeps the api status and puts its detail where the page reads it, instead of a bare "Bad Gateway"', () => {
    const err = upstreamError({ status: 502, data: { detail: 'unknown stock code ZZZZNOTREAL' } })
    expect(err.statusCode).toBe(502)
    expect(err.statusMessage).toBe('unknown stock code ZZZZNOTREAL')
    expect(err.data).toEqual({ detail: 'unknown stock code ZZZZNOTREAL' })
  })

  it('falls back to the error message when the api sent no detail, such as a timeout', () => {
    const err = upstreamError(new Error('request timed out'))
    expect(err.statusCode).toBe(502)
    expect(err.statusMessage).toBe('request timed out')
  })

  it('keeps the status line to one short line', () => {
    const err = upstreamError({ status: 502, data: { detail: `line one\nline two ${'x'.repeat(300)}` } })
    expect(err.statusMessage).not.toContain('\n')
    expect(err.statusMessage!.length).toBeLessThanOrEqual(200)
  })
})
