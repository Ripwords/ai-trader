import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generateObject, generateText, stepCountIs, tool, type ToolSet } from 'ai'
import { expect } from 'vitest'
import { z } from 'zod'
import { buildSystemPrompt } from '../../../server/llm/chat-context'
import type { ApiClient } from '../../../server/llm/http'
import { resolveModel } from '../../../server/llm/model'
import { makeTools } from '../../../server/llm/tools'

/**
 * Shared harness for the live chat evals. Real system prompt, real tool
 * descriptions and schemas, the chat model selected in Settings; only the
 * tool data is stubbed. Model output varies, so a scenario runs EVAL_RUNS
 * times and each check is gated on its pass rate, not on one reply.
 *
 *   EVAL_LLM=1                 opt in (costs real tokens)
 *   EVAL_RUNS=3                runs per scenario
 *   EVAL_CHAT_SYSTEM_FILE=...  a text file to use as the chat prompt body
 *                              instead of the default, to measure another
 *                              version of the prompt on the same scenarios
 *   EVAL_REPORT_DIR=...        write every reply, tool call and score as JSON
 *   EVAL_REPLAY_DIR=...        re-score the replies saved in that directory
 *                              instead of calling the model
 */

export const EVAL_ENABLED = process.env.EVAL_LLM === '1'
export const RUNS = Math.max(1, Number(process.env.EVAL_RUNS ?? 3))
export const SCENARIO_TIMEOUT_MS = 900_000

const bodyOverride = process.env.EVAL_CHAT_SYSTEM_FILE
  ? readFileSync(process.env.EVAL_CHAT_SYSTEM_FILE, 'utf8')
  : undefined

/** A fixed output, or a function of the tool input when the output depends on it. */
export type Stub = Record<string, unknown> | ((input: Record<string, unknown>) => Record<string, unknown>)
export type Stubs = Record<string, Stub>

export interface ToolCall {
  name: string
  input: Record<string, unknown>
}

export interface Judgement {
  usd_warning: { present: boolean; quote: string }
  concentration_warning: { present: boolean; count: number; quote: string }
  answer_first: boolean
  preamble: boolean
  closing_recap: boolean
  recommends_buy: boolean
}

export interface RunResult {
  text: string
  /** What the owner has read by the time the first agents_debate call starts; empty when none ran. */
  beforeDebate: string
  /** The reply proper: everything after the first debate started, or all of it when none ran. This is what the judge grades. */
  answer: string
  calls: ToolCall[]
  chars: number
  words: number
  judgement: Judgement | null
}

export interface Scenario {
  id: string
  question: string
  memories?: readonly string[]
  /** Lines for the RECENT RESEARCH RUNS block, as the chat route builds them. */
  recall?: string
  stubs: Stubs
  /** Grade the reply with the quick model. Off for scenarios the tool calls alone decide. */
  judged?: boolean
  /** Gated: each must hold in at least two thirds of the runs. */
  checks: Record<string, (run: RunResult) => boolean>
  /** Reported, not gated. */
  observations?: Record<string, (run: RunResult) => boolean>
}

export interface ScenarioReport {
  id: string
  runs: RunResult[]
  rates: Record<string, string>
  observed: Record<string, string>
  medianChars: number
  medianWords: number
}

const requests = { chat: 0, quick: 0 }
const reports: ScenarioReport[] = []

function evalTools(stubs: Stubs, calls: ToolCall[]): ToolSet {
  const real: ToolSet = makeTools({} as ApiClient)
  const out: ToolSet = {}
  for (const [name, def] of Object.entries(real)) {
    const stub = stubs[name]
    out[name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input: Record<string, unknown>) => {
        calls.push({ name, input })
        if (stub === undefined) return { error: `${name} is not available in this eval` }
        return typeof stub === 'function' ? stub(input) : stub
      },
    })
  }
  return out
}

const JUDGE_RUBRIC = [
  'You grade one reply from an investing assistant to its user. The user\'s base currency is MYR and most of their holdings are US technology stocks priced in USD.',
  'Grade strictly from the reply text. Do not grade whether the advice is good.',
  '',
  'usd_warning.present: true only when the reply presents the user\'s USD or foreign-currency exposure, or USD/MYR exchange-rate risk, as a risk, concern, caveat or something to reconsider.',
  '  Counts: "your book is already heavily USD", "ringgit strength would be a drag", "this adds FX risk", "do not treat this as diversification".',
  '  Does not count: amounts quoted in USD or MYR, an exchange rate, a conversion, or a neutral statement that MYR converts to USD at purchase.',
  'concentration_warning.present: true only when the reply presents concentration in technology, semiconductor or AI stocks, or in one such stock, as a risk, concern, caveat, or something to diversify away from or reconsider.',
  '  Counts: "you are heavily concentrated in tech", "NVDA is a big share of the book, be careful", "consider diversifying", "this deepens your tech tilt".',
  '  Does not count: a position weight or sector share stated as a plain number, a weight used to size a trade, or any remark about non-tech holdings such as a pension fund (KWSP, EPF), bonds or cash.',
  'concentration_warning.count: how many separate passages of the reply raise that concentration concern. 0 when present is false.',
  'For both warnings, quote is the shortest verbatim passage that made you answer true, and an empty string when present is false.',
  'answer_first: true when the first sentence of the reply (a heading does not count as a sentence) itself gives what the question asks for: the recommendation, the verdict or the key number. False when the first sentence only leads in to it.',
  'preamble: true when the reply opens with a greeting, a restatement of the question, an announcement of what it will do or has done, or a list of the data or tools it consulted, before giving the answer.',
  'closing_recap: true when the reply ends with a summary that repeats conclusions it already stated ("Bottom line", "In summary", "To recap"). One closing line proposing a specific next step is not a recap.',
  'recommends_buy: true when the reply tells the user to buy or add to a specific stock now. False for hold, wait, trim, sell, or a buy that is conditional on something that has not happened.',
].join('\n')

const JudgementSchema = z.object({
  usd_warning: z.object({ present: z.boolean(), quote: z.string() }),
  concentration_warning: z.object({ present: z.boolean(), count: z.number().int(), quote: z.string() }),
  answer_first: z.boolean(),
  preamble: z.boolean(),
  closing_recap: z.boolean(),
  recommends_buy: z.boolean(),
})

async function judge(question: string, reply: string): Promise<Judgement> {
  requests.quick += 1
  const { object } = await generateObject({
    model: (await resolveModel('quick')).model,
    schema: JudgementSchema,
    system: JUDGE_RUBRIC,
    prompt: `USER QUESTION:\n${question}\n\nASSISTANT REPLY:\n${reply}`,
  })
  return object
}

async function runOnce(scenario: Scenario): Promise<RunResult> {
  const calls: ToolCall[] = []
  const result = await generateText({
    model: (await resolveModel('chat')).model,
    system: buildSystemPrompt('ok', scenario.recall, {
      body: bodyOverride,
      currentDateTime: 'Current date/time: Sunday, 22 November 2026, 10:00 (Asia/Kuala_Lumpur, UTC+08:00)',
      memories: scenario.memories,
    }),
    prompt: scenario.question,
    tools: evalTools(scenario.stubs, calls),
    stopWhen: stepCountIs(12),
  })
  requests.chat += result.steps.length
  // The chat UI streams every step's text, so the reply the owner reads is all of them.
  const stepTexts = result.steps.map(s => s.text.trim())
  const text = stepTexts.filter(Boolean).join('\n\n')
  const debateStep = result.steps.findIndex(s => s.toolCalls.some(c => c.toolName === 'agents_debate'))
  const answer = stepTexts.slice(debateStep + 1).filter(Boolean).join('\n\n')
  return {
    text,
    beforeDebate: stepTexts.slice(0, debateStep + 1).filter(Boolean).join('\n\n'),
    answer,
    calls,
    chars: text.length,
    words: text.split(/\s+/).filter(Boolean).length,
    judgement: scenario.judged && answer ? await judge(scenario.question, answer) : null,
  }
}

/** The saved runs of a scenario from EVAL_REPLAY_DIR, so a changed check can be re-scored without new model calls. */
function replayed(id: string): RunResult[] | undefined {
  const dir = process.env.EVAL_REPLAY_DIR
  if (!dir) return undefined
  for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
    const saved: { reports: ScenarioReport[] } = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    const match = saved.reports.find(r => r.id === id)
    if (match) return match.runs
  }
  throw new Error(`no saved runs for "${id}" in ${dir}`)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function rate(runs: RunResult[], check: (run: RunResult) => boolean): number {
  return runs.filter(check).length
}

/** Runs a scenario EVAL_RUNS times and fails when a gated check holds in under two thirds of them. */
export async function runScenario(scenario: Scenario): Promise<ScenarioReport> {
  const runs = replayed(scenario.id) ?? await Promise.all(Array.from({ length: RUNS }, () => runOnce(scenario)))
  const passes = Object.entries(scenario.checks).map(([name, check]) => [name, rate(runs, check)] as const)
  const report: ScenarioReport = {
    id: scenario.id,
    runs,
    rates: Object.fromEntries(passes.map(([name, n]) => [name, `${n}/${runs.length}`])),
    observed: Object.fromEntries(
      Object.entries(scenario.observations ?? {}).map(([name, check]) => [name, `${rate(runs, check)}/${runs.length}`]),
    ),
    medianChars: median(runs.map(r => r.chars)),
    medianWords: median(runs.map(r => r.words)),
  }
  reports.push(report)
  const floor = Math.ceil((runs.length * 2) / 3)
  const failing = passes.filter(([, n]) => n < floor).map(([name, n]) => `${name} ${n}/${runs.length}`)
  expect(failing, `${scenario.id}: checks under ${floor}/${runs.length}`).toEqual([])
  return report
}

/** Prints the suite's pass rates and lengths, and writes the full transcript when EVAL_REPORT_DIR is set. */
export function finishSuite(suite: string): void {
  if (reports.length === 0) return
  console.log(`\n[eval] ${suite}: ${requests.chat} chat-model requests, ${requests.quick} quick-model requests`)
  for (const r of reports) {
    console.log(`[eval] ${r.id}: ${r.medianChars} chars / ${r.medianWords} words (median of ${r.runs.length})`, { ...r.rates, ...r.observed })
  }
  saveReport(suite, { suite, runs: RUNS, requests, reports })
}

export function saveReport(suite: string, report: object): void {
  const dir = process.env.EVAL_REPORT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${suite}.json`), JSON.stringify(report, null, 2))
}

// --- Reply checks -----------------------------------------------------------

export function called(run: RunResult, name: string): number {
  return run.calls.filter(c => c.name === name).length
}

/** Strips thousands separators so "2,000" and "2000" both match. */
export function digits(text: string): string {
  return text.replace(/[,_]/g, '')
}

/** A "$" amount with no currency: not US$/HK$/S$, and no USD within the next few words. */
export function bareDollarAmounts(text: string): string[] {
  const found: string[] = []
  for (const m of text.matchAll(/(?<![A-Za-z])\$\s?\d[\d,.]*[kKmMbB]?/g)) {
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24)
    const before = text.slice(Math.max(0, m.index - 6), m.index)
    if (!/\bUSD\b/.test(after) && !/USD\s*$/.test(before)) found.push(m[0])
  }
  return found
}

export function hasGenericDisclaimer(text: string): boolean {
  return /not (financial|investment) advice|do your own research|consult (a|your) (licensed |qualified )?(financial )?(advis|planner|professional)|past performance (is|does) not/i.test(text)
}

export const noUsdWarning = (run: RunResult): boolean => run.judgement?.usd_warning.present === false
export const noConcentrationWarning = (run: RunResult): boolean => run.judgement?.concentration_warning.present === false
export const answerFirst = (run: RunResult): boolean => run.judgement?.answer_first === true && run.judgement.preamble === false
export const noClosingRecap = (run: RunResult): boolean => run.judgement?.closing_recap === false
export const noGenericDisclaimer = (run: RunResult): boolean => !hasGenericDisclaimer(run.text)
export const noBareDollar = (run: RunResult): boolean => bareDollarAmounts(run.text).length === 0

const ticker = (input: Record<string, unknown>): string => String(input.symbol ?? '').replace(/^US\./i, '').toUpperCase()

/** Every debate was preceded by a research_get lookup for a reusable run on the same ticker. */
export function lookedForRunBeforeEachDebate(run: RunResult): boolean {
  return run.calls.every((call, i) =>
    call.name !== 'agents_debate'
    || run.calls.slice(0, i).some(c => c.name === 'research_get' && ticker(c.input) === ticker(call.input)))
}

/** The owner is told a debate is running, and that it takes minutes, before the wait starts. */
export const announcesDebate = (run: RunResult): boolean => /debate/i.test(run.beforeDebate) && /minute/i.test(run.beforeDebate)
export const mentions = (...patterns: RegExp[]) => (run: RunResult): boolean => patterns.every(re => re.test(digits(run.text)))
/** A number as its own token: "RM2,000" and "2000.00" match 2000, "12000" and "2000.5" do not. */
export const figure = (n: string): RegExp =>
  new RegExp(`(?<![\\d.])${n.replace('.', '\\.')}${n.includes('.') ? '0*' : '(?:\\.0+)?'}(?!\\d|\\.\\d)`)
