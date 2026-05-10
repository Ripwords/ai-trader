import { describe, expect, it } from 'vitest'
import { getTableColumns } from 'drizzle-orm'
import {
  agentDecisions,
  agentMessages,
  agentReflections,
  agentRuns,
} from '../../db/schema'

const NAME = Symbol.for('drizzle:Name')

describe('agent_* schema', () => {
  it('agent_runs has expected columns and table name', () => {
    expect((agentRuns as unknown as Record<symbol, string>)[NAME]).toBe('agent_runs')
    const cols = Object.keys(getTableColumns(agentRuns))
    for (const c of [
      'id',
      'userId',
      'symbol',
      'tradeDate',
      'config',
      'status',
      'resumedFrom',
      'tokensIn',
      'tokensOut',
      'costUsd',
      'error',
      'startedAt',
      'finishedAt',
    ]) {
      expect(cols).toContain(c)
    }
  })

  it('agent_messages has expected columns and references agent_runs', () => {
    expect((agentMessages as unknown as Record<symbol, string>)[NAME]).toBe('agent_messages')
    const cols = Object.keys(getTableColumns(agentMessages))
    for (const c of ['id', 'runId', 'seq', 'kind', 'node', 'payload', 'createdAt']) {
      expect(cols).toContain(c)
    }
  })

  it('agent_decisions has expected columns including nullable paperOrderId', () => {
    expect((agentDecisions as unknown as Record<symbol, string>)[NAME]).toBe('agent_decisions')
    const cols = getTableColumns(agentDecisions)
    const colNames = Object.keys(cols)
    for (const c of [
      'id',
      'runId',
      'userId',
      'symbol',
      'tradeDate',
      'rating',
      'confidence',
      'rationale',
      'priceAtDecision',
      'paperOrderId',
      'createdAt',
    ]) {
      expect(colNames).toContain(c)
    }
    // paperOrderId is nullable (no FK yet — paper_orders table not introduced)
    expect(cols.paperOrderId.notNull).toBe(false)
  })

  it('agent_reflections is keyed by decisionId uniquely', () => {
    expect((agentReflections as unknown as Record<symbol, string>)[NAME]).toBe('agent_reflections')
    const cols = Object.keys(getTableColumns(agentReflections))
    for (const c of [
      'id',
      'decisionId',
      'reflectedAt',
      'horizonDays',
      'realizedReturn',
      'benchmarkReturn',
      'alpha',
      'outcome',
      'text',
    ]) {
      expect(cols).toContain(c)
    }
  })
})
