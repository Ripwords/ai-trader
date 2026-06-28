import { defineEventHandler, readBody } from 'h3'
import { startAgentRun, drainIntoTee, type AgentsRunBody } from '../../lib/agents/start-run'

/**
 * Fire-and-forget research run. Creates the agent_runs row and opens the
 * upstream stream synchronously (so resolution/concurrency errors surface to
 * the caller), then drains the stream into the DB in a DETACHED promise and
 * returns the run id immediately. The browser is notified of completion by the
 * global ActiveRunsWatcher polling /api/research/active-runs.
 */
export default defineEventHandler(async (event) => {
  const body = await readBody<AgentsRunBody>(event)
  const { run, userId, upstream } = await startAgentRun(body)
  // Detached: survives the response under the long-lived Node server.
  void drainIntoTee(upstream, run.id, userId)
  return { runId: run.id, status: 'running' as const, symbol: run.symbol }
})
