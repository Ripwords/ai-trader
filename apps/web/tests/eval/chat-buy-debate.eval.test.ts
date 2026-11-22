import { afterAll, describe, it } from 'vitest'
import {
  EVAL_ENABLED,
  SCENARIO_TIMEOUT_MS,
  announcesDebate,
  called,
  figure,
  finishSuite,
  lookedForRunBeforeEachDebate,
  mentions,
  runScenario,
  type RunResult,
  type Scenario,
} from './support/harness'
import {
  FRESH_NVDA_RUN,
  PAPER_ORDER_ACCEPTED,
  VERDICT_MU_SELL,
  VERDICT_NVDA_BUY,
  debate,
  ownerStubs,
} from './support/owner-fixtures'

/**
 * Live eval of "debate before a buy": the assistant gets an agents verdict
 * before it recommends buying a stock, reuses a fresh run instead of paying
 * for a new one, runs no debate when no buy is being recommended, and leads
 * with a verdict that disagrees with it. The debate itself is stubbed, so a
 * scenario costs chat-model requests only.
 *
 *   EVAL_LLM=1 DATABASE_URL=... ENCRYPTION_KEY=... npx vitest run tests/eval/chat-buy-debate
 */

const debates = (run: RunResult): number => called(run, 'agents_debate')
const noDebate = (run: RunResult): boolean => debates(run) === 0 && called(run, 'research_start') === 0

const SCENARIOS: Scenario[] = [
  {
    id: 'add to NVDA with a 2-day-old run',
    question: 'Should I add to NVDA?',
    recall: `NVDA — research 2d ago: buy conf 71 (run ${FRESH_NVDA_RUN.runId})`,
    stubs: ownerStubs({ research_get: FRESH_NVDA_RUN }),
    checks: {
      reusesTheRun: noDebate,
      citesVerdict: mentions(figure('71')),
      statesAge: run => /\b2\s?-?\s?d(ays?)?\b|two days/i.test(run.text),
    },
  },
  {
    id: 'is NVDA cheap (factual)',
    question: 'Is NVDA cheap right now?',
    stubs: ownerStubs(),
    checks: { noDebate, valued: run => called(run, 'value_stock') >= 1 },
  },
  {
    id: 'should I trim PLTR (sell-side)',
    question: 'Should I trim PLTR?',
    stubs: ownerStubs(),
    checks: { noDebate },
  },
  {
    id: 'place the order I already decided',
    question: 'I have decided: buy 5 NVDA at a 172 limit on the paper account. Yes, place it.',
    stubs: ownerStubs({ trade_place_order: PAPER_ORDER_ACCEPTED }),
    checks: {
      noDebate,
      placedOnPaper: run =>
        called(run, 'trade_place_order') === 1
        && run.calls.every(c => c.name !== 'trade_place_order' || c.input.trd_env !== 'REAL'),
    },
  },
  {
    id: 'lean buy on MU, debate says sell',
    question: 'MU looks cheap to me and I am thinking of adding to it. Should I?',
    stubs: ownerStubs({ agents_debate: debate({ MU: VERDICT_MU_SELL }) }),
    judged: true,
    checks: {
      debated: run => debates(run) >= 1,
      atMostTwoDebates: run => debates(run) <= 2,
      announcesDebate,
      verdictUpFront: run => /\bsell\b/i.test(run.answer.slice(0, 400)),
      followsTheVerdict: run => run.judgement?.recommends_buy === false,
    },
    observations: { lookedForRunBeforeEachDebate },
  },
  {
    id: 'which of five names to add to',
    question: 'Which of NVDA, MSFT, TSM, MU and AAPL should I add to this month?',
    stubs: ownerStubs({ agents_debate: debate({ NVDA: VERDICT_NVDA_BUY, MU: VERDICT_MU_SELL }) }),
    checks: {
      debated: run => debates(run) >= 1,
      atMostTwoDebates: run => debates(run) <= 2,
      announcesDebate,
    },
    observations: { oneDebate: run => debates(run) === 1, lookedForRunBeforeEachDebate },
  },
]

const d = EVAL_ENABLED ? describe : describe.skip

d('debate before a buy', () => {
  afterAll(() => finishSuite('chat-buy-debate'))

  it.concurrent.each(SCENARIOS)('$id', async (scenario) => {
    await runScenario(scenario)
  }, SCENARIO_TIMEOUT_MS)
})
