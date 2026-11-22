import { afterAll, describe, it } from 'vitest'
import {
  EVAL_ENABLED,
  SCENARIO_TIMEOUT_MS,
  announcesDebate,
  answerFirst,
  called,
  digits,
  figure,
  finishSuite,
  lookedForRunBeforeEachDebate,
  mentions,
  noBareDollar,
  noClosingRecap,
  noConcentrationWarning,
  noGenericDisclaimer,
  noUsdWarning,
  runScenario,
  type RunResult,
  type Scenario,
} from './support/harness'
import {
  MEMORY_TECH_KNOWN,
  MEMORY_TECH_KNOWN_AT_25,
  MEMORY_USD_INTENTIONAL,
  investmentPortfolio,
  ownerStubs,
} from './support/owner-fixtures'

/**
 * Live eval of two owner complaints: the assistant re-warns about USD exposure
 * and tech concentration the owner has already settled, and its replies are
 * long. Each scenario asks a real question against one invented book (all USD,
 * about 92% tech) and grades the reply for warnings, shape and the figures it
 * must still carry. Reply length is reported per scenario; run the suite with
 * EVAL_CHAT_SYSTEM_FILE to measure another version of the prompt.
 *
 *   EVAL_LLM=1 DATABASE_URL=... ENCRYPTION_KEY=... npx vitest run tests/eval/chat-settled-risks
 */

const SETTLED = [MEMORY_USD_INTENTIONAL, MEMORY_TECH_KNOWN]

const style = { answerFirst, noClosingRecap, noGenericDisclaimer, noBareDollar }
const quiet = { noUsdWarning, noConcentrationWarning }

const BUY_THIS_MONTH = 'I have RM 2,000 to invest this month. What should I buy to get closer to my target? Do not place any orders and do not change my plan.'

/** RM 2,000 buys whole shares of one holding only: the trade's value and what is left unspent, in MYR. */
const planAmounts = (run: RunResult): boolean =>
  [/(?<!\d)(1428\.76|1429)(?!\d)/, /(?<!\d)571(\.24)?(?!\d)/].every(amount => amount.test(digits(run.text)))

/** The pension is locked out of the plan's percentages; a reply that still calls it a concentration is relaying a nag. */
const relaysPensionFlag = (run: RunResult): boolean =>
  /KWSP|EPF/i.test(run.text) && /critical|concentrat|threshold/i.test(run.text)

/** The no-memory controls report this: how often the same question draws a warning when nothing is settled. */
const flagsUsdOrConcentration = (run: RunResult): boolean =>
  run.judgement?.usd_warning.present === true || run.judgement?.concentration_warning.present === true

const debated = (run: RunResult): boolean => called(run, 'agents_debate') >= 1
const atMostTwoDebates = (run: RunResult): boolean => called(run, 'agents_debate') <= 2

const SCENARIOS: Scenario[] = [
  {
    id: 'buy this month, risks settled',
    question: BUY_THIS_MONTH,
    memories: SETTLED,
    stubs: ownerStubs(),
    judged: true,
    checks: {
      ...quiet,
      ...style,
      keepsContribution: mentions(figure('2000'), /MYR|RM/),
      keepsPlanAmounts: planAmounts,
      atMostTwoDebates,
    },
    observations: { relaysPensionFlag, debated },
  },
  {
    id: 'buy this month, no memory',
    question: BUY_THIS_MONTH,
    stubs: ownerStubs(),
    judged: true,
    checks: { keepsPlanAmounts: planAmounts },
    observations: { flagsUsdOrConcentration, ...style, relaysPensionFlag },
  },
  {
    id: 'review my portfolio, no memory',
    question: 'Review my portfolio.',
    stubs: ownerStubs(),
    judged: true,
    checks: { keepsDayChange: mentions(/0\.63/) },
    observations: { flagsUsdOrConcentration, ...style },
  },
  {
    id: 'review my portfolio, risks settled',
    question: 'Review my portfolio.',
    memories: SETTLED,
    stubs: ownerStubs(),
    judged: true,
    checks: {
      ...quiet,
      ...style,
      keepsTotal: run => /US\$\s?1857[56]|1857[56](\.\d+)?\s?USD|RM\s?7709[01]|7709[01](\.\d+)?\s?MYR/.test(digits(run.text)),
      keepsDayChange: mentions(/0\.63/),
      keepsUnrealizedPl: run => /431[78]|1791[78]/.test(digits(run.text)),
    },
    observations: { totalInMyr: mentions(/7709[01]/, /MYR|RM/) },
  },
  {
    id: 'should I add to NVDA, risks settled',
    question: 'Should I add to NVDA?',
    memories: SETTLED,
    stubs: ownerStubs(),
    judged: true,
    checks: {
      ...quiet,
      ...style,
      debated,
      atMostTwoDebates,
      announcesDebate,
      citesVerdict: mentions(figure('68')),
      keepsHolding: mentions(figure('40')),
    },
    observations: { lookedForRunBeforeEachDebate },
  },
  {
    id: 'how did I do this week, risks settled',
    question: 'How did I do this week?',
    memories: SETTLED,
    stubs: ownerStubs(),
    judged: true,
    checks: {
      ...quiet,
      ...style,
      keepsFlowNeutralReturn: mentions(/26\.(47|5)/, /30\.(28|3)/),
      disclosesNewMoney: run => /new money|deposit|contribut|bought|purchase|new buy|cost basis|inflow/i.test(run.text),
      noDebate: run => !debated(run),
    },
  },
  {
    id: 'review my portfolio, NVDA far past the remembered weight',
    question: 'Review my portfolio.',
    memories: [MEMORY_USD_INTENTIONAL, MEMORY_TECH_KNOWN_AT_25],
    stubs: ownerStubs({ investment_portfolio: investmentPortfolio(94) }),
    judged: true,
    checks: {
      noUsdWarning,
      raisesTheChangeOnce: run =>
        run.judgement?.concentration_warning.present === true && run.judgement.concentration_warning.count === 1,
      keepsNewWeight: mentions(/(?<!\d)58(\.\d+)?\s?%/),
    },
    observations: style,
  },
]

const d = EVAL_ENABLED ? describe : describe.skip

d('settled risks and reply length', () => {
  afterAll(() => finishSuite('chat-settled-risks'))

  it.concurrent.each(SCENARIOS)('$id', async (scenario) => {
    await runScenario(scenario)
  }, SCENARIO_TIMEOUT_MS)
})
