import net from 'node:net'
import { afterEach, expect, it } from 'vitest'
import { applyConnectAttemptTimeout } from '../../server/utils/connect-timeout'

// Node's happy-eyeballs gives each resolved address 250 ms to connect. Yahoo's
// US edge (69.147.80.x) takes ~310 ms from Malaysia and the container has no
// IPv6 route, so every attempt was abandoned and every Yahoo call failed with
// ETIMEDOUT.
const original = net.getDefaultAutoSelectFamilyAttemptTimeout()
afterEach(() => net.setDefaultAutoSelectFamilyAttemptTimeout(original))

it('raises the per-address connect attempt well above a trans-Pacific round trip', () => {
  expect(original).toBe(250)
  applyConnectAttemptTimeout()
  expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBeGreaterThanOrEqual(1000)
})
