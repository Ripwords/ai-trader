import { describe, expect, it, vi } from 'vitest'
import { askConfirm } from '../../app/lib/confirm'
import { apiErrorMessage } from '../../app/lib/api-error'

describe('askConfirm', () => {
  const opts = { title: 'Delete strategy "x"?', confirmLabel: 'Delete' }

  it('is true only when the confirm button was pressed', async () => {
    const open = vi.fn(() => ({ result: Promise.resolve(true) }))
    await expect(askConfirm(open, opts)).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith(opts)
  })

  it('is false on Cancel', async () => {
    await expect(askConfirm(() => ({ result: Promise.resolve(false) }), opts)).resolves.toBe(false)
  })

  // Esc and the close button dismiss the UModal without emitting `close`;
  // the overlay then resolves with undefined.
  it('is false when dismissed with Esc', async () => {
    await expect(askConfirm(() => ({ result: Promise.resolve(undefined) }), opts)).resolves.toBe(false)
  })
})

describe('apiErrorMessage', () => {
  it('prefers the api detail', () => {
    expect(apiErrorMessage({ data: { detail: 'OpenD down' }, message: 'x' }, 'fallback')).toBe('OpenD down')
  })

  it('uses the h3 statusMessage', () => {
    expect(apiErrorMessage({ statusMessage: 'Bad Gateway', message: 'x' }, 'fallback')).toBe('Bad Gateway')
  })

  it('falls back to the error message', () => {
    expect(apiErrorMessage(new Error('fetch failed'), 'fallback')).toBe('fetch failed')
  })

  it('uses the fallback for anything else', () => {
    expect(apiErrorMessage(null, 'fallback')).toBe('fallback')
    expect(apiErrorMessage('boom', 'fallback')).toBe('fallback')
  })
})
