import { defineEventHandler, readBody } from 'h3'
import { startAgentRun, drainIntoTee, type AgentsRunBody } from '../../lib/agents/start-run'

/**
 * Start a research run. Resolution and concurrency errors surface to the
 * caller; the stream itself drains into agent_messages in a detached promise,
 * and readers follow it through /api/research/agent-events.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<AgentsRunBody>(event)
  const { run, userId, upstream } = await startAgentRun(body)
  void drainIntoTee(upstream, run.id, userId)
  return { runId: run.id, status: 'running' as const, symbol: run.symbol }
})
