import { createError } from 'h3'

/**
 * Nitro turns a rethrown ofetch error into its bare status text ("Bad Gateway"),
 * so the page never sees why the api refused. Carry the api's `detail` in the
 * status line, which is what the page's error helper reads.
 */
export function upstreamError(e: unknown) {
  const err = (typeof e === 'object' && e !== null ? e : {}) as { status?: number; statusCode?: number; data?: { detail?: unknown }; message?: string }
  const detail = typeof err.data?.detail === 'string' && err.data.detail ? err.data.detail : (err.message || 'the api did not answer')
  return createError({
    statusCode: err.status ?? err.statusCode ?? 502,
    statusMessage: detail.replace(/\s+/g, ' ').slice(0, 200),
    data: { detail },
  })
}
