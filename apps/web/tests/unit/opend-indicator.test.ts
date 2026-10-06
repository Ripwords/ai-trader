import { describe, expect, it } from 'vitest'
import { opendIndicator } from '../../app/utils/opend-indicator'

describe('opendIndicator', () => {
  it('is neutral while the first poll is in flight', () => {
    expect(opendIndicator(null)).toEqual({ tone: 'neutral', label: 'opend · checking' })
  })

  it('is down when OpenD is unreachable', () => {
    expect(opendIndicator({ reachable: false, qot_logined: false, trd_logined: false }))
      .toEqual({ tone: 'down', label: 'opend · down' })
  })

  it('is down when reachable but not logged in for quotes', () => {
    expect(opendIndicator({ reachable: true, qot_logined: false, trd_logined: true }))
      .toEqual({ tone: 'down', label: 'opend · no quotes' })
  })

  it('is up when quotes are live', () => {
    expect(opendIndicator({ reachable: true, qot_logined: true, trd_logined: false }))
      .toEqual({ tone: 'up', label: 'live · paper' })
  })
})
