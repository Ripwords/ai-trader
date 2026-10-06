import type { AlgoMaturityCheck } from '../../server/lib/algo-risk'
import type { AlgoSizingMode } from '../../server/llm/http'

export interface CheckFold {
  /** Warn and block checks, blocks first. These render open. */
  open: AlgoMaturityCheck[]
  passed: AlgoMaturityCheck[]
  /** The one line that stands in for every passing check, or null when none passed. */
  summary: string | null
}

export function foldChecks(checks: readonly AlgoMaturityCheck[]): CheckFold {
  const passed = checks.filter(c => c.status === 'pass')
  const open = [
    ...checks.filter(c => c.status === 'block'),
    ...checks.filter(c => c.status === 'warn'),
  ]
  let summary: string | null = null
  if (passed.length > 0) {
    summary = open.length === 0
      ? `all ${passed.length} check${passed.length === 1 ? '' : 's'} passed`
      : `${passed.length} passed`
  }
  return { open, passed, summary }
}

interface SizingModeMeta {
  label: string
  /** Label for the sizing value input under this mode. */
  valueLabel: string
  valueHelp: string
  describe: (value: number) => string
}

const SIZING: Record<AlgoSizingMode, SizingModeMeta> = {
  fixed_qty: {
    label: 'fixed shares',
    valueLabel: 'shares',
    valueHelp: 'bought on every signal, capped at available cash.',
    describe: v => `${v} share${v === 1 ? '' : 's'} per signal`,
  },
  pct_equity: {
    label: '% of equity',
    valueLabel: '% of equity',
    valueHelp: 'of cash plus position value per signal. winners compound.',
    describe: v => `${v}% of equity per signal`,
  },
  fixed_cash: {
    label: 'fixed dollars',
    valueLabel: 'dollars',
    valueHelp: 'committed per signal, divided by the fill price.',
    describe: v => `$${v.toLocaleString('en-US')} per signal`,
  },
}

export const SIZING_MODES = (Object.keys(SIZING) as AlgoSizingMode[])
  .map(value => ({ value, label: SIZING[value].label }))

export function sizingMeta(mode: AlgoSizingMode): SizingModeMeta {
  return SIZING[mode]
}

export function describeSizing(mode: AlgoSizingMode, value: number): string {
  return SIZING[mode].describe(value)
}
