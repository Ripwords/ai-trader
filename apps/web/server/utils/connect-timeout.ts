import net from 'node:net'

/**
 * Per-address connect timeout for Node's happy-eyeballs (default 250 ms). A
 * host whose IPv4 edge is slower than that, with no IPv6 route, fails every
 * attempt: Yahoo's US edge is ~310 ms away from Malaysia.
 */
export const CONNECT_ATTEMPT_MS = 2000

export function applyConnectAttemptTimeout(): void {
  net.setDefaultAutoSelectFamilyAttemptTimeout(CONNECT_ATTEMPT_MS)
}
