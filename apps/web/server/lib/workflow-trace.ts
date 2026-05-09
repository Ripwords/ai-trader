import { analyzeTickerWorkflow } from '../mastra'
import { getOwnerId, recordWorkflowRun, type WorkflowRunStep } from '../db/repo'

type AnalystName = 'fundamentals' | 'valuation' | 'technicals' | 'sentiment'
type PersonaName = 'buffett' | 'munger' | 'burry' | 'druckenmiller' | 'wood'

export interface AnalyzeTickerInput {
  symbol: string
  analysts: AnalystName[]
  personas: PersonaName[]
}

interface MastraStepData {
  status?: string
  startedAt?: number
  endedAt?: number
  error?: { message?: string }
}

function isStepData(x: unknown): x is MastraStepData {
  return typeof x === 'object' && x !== null
}

/**
 * Wraps `analyzeTickerWorkflow.createRun().start()` with timing
 * instrumentation. Inspects `result.steps` for per-step durations and
 * persists a `workflow_runs` row so /research/runs can surface why a
 * 60s run was actually slow. Persistence failures are swallowed — they
 * must never break the workflow's return contract.
 */
export async function runAnalyzeTickerTraced(input: AnalyzeTickerInput) {
  const startedAt = Date.now()
  const run = await analyzeTickerWorkflow.createRun()
  const result = await run.start({ inputData: input })
  const totalMs = Date.now() - startedAt

  const steps: WorkflowRunStep[] = []
  const rawSteps = (result as { steps?: unknown }).steps
  if (rawSteps && typeof rawSteps === 'object') {
    for (const [stepId, stepData] of Object.entries(rawSteps as Record<string, unknown>)) {
      if (!isStepData(stepData)) continue
      const ms = stepData.startedAt && stepData.endedAt
        ? stepData.endedAt - stepData.startedAt
        : 0
      const step: WorkflowRunStep = {
        id: stepId,
        status: stepData.status ?? 'unknown',
        ms,
      }
      if (stepData.error?.message) step.error = stepData.error.message
      steps.push(step)
    }
  }

  try {
    const ownerId = await getOwnerId()
    await recordWorkflowRun(ownerId, {
      workflowId: 'analyze-ticker',
      inputSummary: {
        symbol: input.symbol,
        analysts: input.analysts,
        personas: input.personas,
      },
      status: result.status === 'success' ? 'success' : 'failed',
      totalMs,
      steps,
      errorMessage: result.status === 'failed' ? String(result) : null,
    })
  } catch (err) {
    console.error('[trace] failed to persist run', err)
  }

  return result
}
