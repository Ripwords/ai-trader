import { describe, it, expect } from 'vitest'
import { parseSlashCommand, SLASH_COMMANDS } from '../../server/llm/research/commands'

describe('SLASH_COMMANDS', () => {
  it('registers all seven commands mapped to their tools', () => {
    const names = SLASH_COMMANDS.map(c => c.name).sort()
    expect(names).toEqual([
      'deep-company-series', 'dyp-ask', 'investment-research', 'investment-team',
      'management-deep-dive', 'news-pulse', 'thesis-tracker',
    ])
    const research = SLASH_COMMANDS.find(c => c.name === 'investment-research')!
    expect(research.tool).toBe('investment_research')
    expect(research.preset).toBe('research')
  })
})

describe('parseSlashCommand', () => {
  it('returns null for non-slash text', () => {
    expect(parseSlashCommand('hello world')).toBeNull()
    expect(parseSlashCommand('  not a command')).toBeNull()
  })
  it('returns null for an unknown command', () => {
    expect(parseSlashCommand('/nope AAPL')).toBeNull()
  })
  it('parses a single symbol arg', () => {
    const p = parseSlashCommand('/investment-research 腾讯')!
    expect(p.command.tool).toBe('investment_research')
    expect(p.command.preset).toBe('research')
    expect(p.args.symbol).toBe('腾讯')
  })
  it('maps preset commands to the same tool with their preset', () => {
    expect(parseSlashCommand('/investment-team 美团')!.command.preset).toBe('team')
    expect(parseSlashCommand('/deep-company-series 拼多多')!.command.preset).toBe('series')
  })
  it('parses person + symbol for management-deep-dive', () => {
    const p = parseSlashCommand('/management-deep-dive 王兴 美团')!
    expect(p.command.preset).toBe('management')
    expect(p.args.person).toBe('王兴')
    expect(p.args.symbol).toBe('美团')
  })
  it('captures the whole rest-of-line as the question for dyp-ask', () => {
    const p = parseSlashCommand('/dyp-ask 拼多多的护城河到底在哪里？')!
    expect(p.command.tool).toBe('dyp_ask')
    expect(p.args.question).toBe('拼多多的护城河到底在哪里？')
  })
  it('handles news-pulse and thesis-tracker', () => {
    expect(parseSlashCommand('/news-pulse 腾讯')!.command.tool).toBe('news_pulse')
    expect(parseSlashCommand('/thesis-tracker 拼多多')!.command.tool).toBe('thesis_tracker')
  })
  it('last arg soaks up all remaining tokens (multi-word remainder)', () => {
    // single last arg: all 3 tokens become the symbol
    const p1 = parseSlashCommand('/investment-research Alibaba Group Holding')!
    expect(p1.args.symbol).toBe('Alibaba Group Holding')

    // two args: first takes one token, last soaks the remaining two
    const p2 = parseSlashCommand('/management-deep-dive 王兴 美团 Holdings')!
    expect(p2.args.person).toBe('王兴')
    expect(p2.args.symbol).toBe('美团 Holdings')
  })
})
