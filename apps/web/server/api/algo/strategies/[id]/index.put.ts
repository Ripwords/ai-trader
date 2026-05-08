import type { AlgoStrategyUpdate } from '../../../../llm/http'
import { getAlgoApi } from '../../../../llm/http'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id') as string
  const body = await readBody<AlgoStrategyUpdate>(event)
  try {
    return await getAlgoApi().updateStrategy(id, body)
  } catch (e) {
    // ofetch wraps upstream errors as FetchError with `status`/`data`. By
    // default Nuxt would re-emit this as a generic 500 "Server Error" and
    // strip the body — so the frontend can't show the real reason
    // (e.g. FastAPI's `{detail: "line 5: syntax error: ..."}` from the
    // strategy validator). Re-throw as a proper h3 error with the
    // upstream status + body preserved.
    const err = e as { status?: number; statusCode?: number; data?: unknown; message?: string }
    throw createError({
      statusCode: err.status ?? err.statusCode ?? 500,
      statusMessage: 'Upstream error',
      data: err.data ?? { detail: err.message ?? 'unknown' },
    })
  }
})
