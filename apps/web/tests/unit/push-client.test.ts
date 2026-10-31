import { describe, expect, it } from 'vitest'
import { subscribedWithKey, urlBase64ToUint8Array } from '../../app/lib/push'

const KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U'

describe('subscribedWithKey', () => {
  it('accepts a subscription made with the server key', () => {
    expect(subscribedWithKey(urlBase64ToUint8Array(KEY).buffer, KEY)).toBe(true)
  })

  it('rejects one made with an older key, so enabling push again replaces it instead of reusing a subscription every push is refused on', () => {
    const old = urlBase64ToUint8Array(KEY)
    old[5] = old[5]! ^ 0xff
    expect(subscribedWithKey(old.buffer, KEY)).toBe(false)
  })

  it('trusts a subscription whose key the browser does not report', () => {
    expect(subscribedWithKey(null, KEY)).toBe(true)
  })
})
