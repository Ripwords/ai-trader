import type { OpendStatus } from '~/composables/useOpendStatus'

export interface OpendIndicator {
  tone: 'up' | 'down' | 'neutral'
  label: string
}

/** The shell's broker readout: one tone and one lowercase label per OpenD state. */
export function opendIndicator(status: OpendStatus | null): OpendIndicator {
  if (status === null) return { tone: 'neutral', label: 'opend · checking' }
  if (!status.reachable) return { tone: 'down', label: 'opend · down' }
  if (!status.qot_logined) return { tone: 'down', label: 'opend · no quotes' }
  return { tone: 'up', label: 'live · paper' }
}
