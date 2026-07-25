import { describe, expect, it } from 'vitest'
import { buildSystemPrompt } from '../../server/llm/chat-context'
import { makeTools } from '../../server/llm/tools'
import type { ApiClient } from '../../server/llm/http'

/**
 * Guards the narration layer without invoking a model.
 *
 * The regression these cover: the chat answered "check my portfolio" with a
 * Ghostfolio net-worth delta (RM 140,712 → RM 140,654, "-0.04% overnight"),
 * and separately reported the moomoo account in HKD when it reports in MYR.
 */

const fakeClient = {} as ApiClient

function toolNames(): string[] {
  return Object.keys(makeTools(fakeClient))
}

function toolDescription(name: string): string {
  const t = makeTools(fakeClient) as Record<string, { description?: string }>
  const desc = t[name]?.description
  if (!desc) throw new Error(`tool ${name} has no description`)
  return desc
}

describe('portfolio prompt contract', () => {
  it('registers investment_portfolio as the investments-layer tool', () => {
    expect(toolNames()).toContain('investment_portfolio')
  })

  it('routes the default portfolio question to investment_portfolio', () => {
    const desc = toolDescription('investment_portfolio').toLowerCase()
    expect(desc).toContain('moomoo')
    expect(desc).toMatch(/day change|today/)
    // It must claim the unqualified portfolio question.
    expect(desc).toMatch(/my portfolio|how am i doing|default/)
  })

  it('warns that investment_performance value change is not a return', () => {
    const desc = toolDescription('investment_performance')
    expect(desc).toContain('flowsDetected')
    expect(desc).toMatch(/NOT a return/i)
    // It must not be confused with the net-worth curve or with today's read.
    expect(desc).toContain('portfolio_performance')
    expect(desc).toContain('investment_portfolio')
  })

  it('tells the model to disclose flows rather than narrate deposits as gains', () => {
    const prompt = buildSystemPrompt('ok')
    expect(prompt).toContain('investment_performance')
    expect(prompt).toContain('flowsDetected')
    expect(prompt).toMatch(/new money/i)
  })

  it('labels portfolio_performance as net-worth history, not investment performance', () => {
    const desc = toolDescription('portfolio_performance').toLowerCase()
    expect(desc).toContain('net worth')
    // It must actively disclaim the investments question.
    expect(desc).toMatch(/not .*investment|investment_portfolio/)
  })

  it('states the layer contract in the system prompt', () => {
    const prompt = buildSystemPrompt('ok')
    expect(prompt).toContain('PORTFOLIO SCOPE')
    expect(prompt).toContain('investment_portfolio')
    // Net worth must never be narrated as portfolio performance.
    expect(prompt.toLowerCase()).toMatch(/never.*net worth.*performance|net worth.*not.*performance/)
  })

  it('carries the layer contract regardless of Ghostfolio status', () => {
    for (const status of ['ok', 'failing', 'not_configured'] as const) {
      const prompt = buildSystemPrompt(status)
      expect(prompt, `status=${status}`).toContain('PORTFOLIO SCOPE')
      expect(prompt, `status=${status}`).toContain('investment_portfolio')
    }
  })

  it('makes no hardcoded claim that moomoo reports in HKD', () => {
    const surfaces = [
      buildSystemPrompt('ok'),
      buildSystemPrompt('failing'),
      buildSystemPrompt('not_configured'),
      toolDescription('trade_account_overview'),
      toolDescription('trade_portfolio'),
      toolDescription('investment_portfolio'),
    ]
    for (const text of surfaces) {
      expect(text).not.toMatch(/usually HKD/i)
      expect(text).not.toMatch(/report in HKD/i)
      expect(text).not.toMatch(/base currency \(usually/i)
      // "converted into HKD" was the specific phrasing that taught the model
      // to narrate a currency the user doesn't hold.
      expect(text).not.toMatch(/CONVERTED into HKD/i)
    }
  })

  it('tells the model the reporting currency is a server setting, not a broker fact', () => {
    const prompt = buildSystemPrompt('ok')
    expect(prompt).toMatch(/reporting currency/i)
    expect(prompt).toMatch(/cash_by_currency/)
  })
})
