import { describe, expect, it } from 'vitest'
import { makeTools } from '../../server/llm/tools'
import type { ApiClient } from '../../server/llm/http'
import { GHOSTFOLIO_TOOL_ALLOWLIST } from '../../server/llm/mcp'
import { SLASH_COMMANDS } from '../../server/llm/research/commands'
import {
  GHOSTFOLIO_CATALOG,
  TOOL_CATALOG,
  TOOL_CATEGORIES,
  TOOLS_GUIDE_COMMAND,
  buildToolGuide,
  isToolsGuideCommand,
} from '../../server/llm/tool-catalog'

/**
 * The /tools guide is only useful while it matches what the chat can really
 * call. These tests fail the moment a tool is added, renamed or removed
 * without its catalog entry following, in either direction.
 */

const nativeTools = () => Object.keys(makeTools({} as ApiClient)).sort()
const allEntries = () => [...Object.entries(TOOL_CATALOG), ...Object.entries(GHOSTFOLIO_CATALOG)]

describe('tool catalog coverage', () => {
  it('has an entry for every tool makeTools registers, and no others', () => {
    expect(Object.keys(TOOL_CATALOG).sort()).toEqual(nativeTools())
  })

  it('has an entry for every allowlisted Ghostfolio tool, and no others', () => {
    const expected = [...GHOSTFOLIO_TOOL_ALLOWLIST].map(n => `ghostfolio_${n}`).sort()
    expect(Object.keys(GHOSTFOLIO_CATALOG).sort()).toEqual(expected)
  })

  it('fills every field of every entry with a known category', () => {
    for (const [name, e] of allEntries()) {
      expect(TOOL_CATEGORIES, name).toContain(e.category)
      expect(e.what.trim(), `${name}.what`).not.toBe('')
      expect(e.useWhen.trim(), `${name}.useWhen`).not.toBe('')
      expect(e.example.trim(), `${name}.example`).not.toBe('')
    }
  })

  it('links each slash command from the entry of the tool it dispatches to', () => {
    for (const cmd of SLASH_COMMANDS) {
      const entry = TOOL_CATALOG[cmd.tool as keyof typeof TOOL_CATALOG]
      expect(entry?.slash ?? [], `/${cmd.name} -> ${cmd.tool}`).toContain(cmd.name)
    }
  })

  it('names only slash commands that exist and dispatch to that tool', () => {
    const byName = new Map(SLASH_COMMANDS.map(c => [c.name, c]))
    for (const [name, e] of Object.entries(TOOL_CATALOG)) {
      for (const slash of e.slash ?? []) {
        expect(byName.get(slash)?.tool, `${name} -> /${slash}`).toBe(name)
      }
    }
  })
})

describe('buildToolGuide', () => {
  it('groups native tools by category in the declared order, skipping empty ones', () => {
    const guide = buildToolGuide({ ghostfolio: 'not_configured' })
    const names = guide.categories.map(c => c.category)
    expect(names).toEqual(TOOL_CATEGORIES.filter(c => names.includes(c)))
    expect(guide.categories.every(c => c.tools.length > 0)).toBe(true)
    const listed = guide.categories.flatMap(c => c.tools.map(t => t.name)).sort()
    expect(listed).toEqual(nativeTools())
  })

  it('lists the Ghostfolio tracker tools only when Ghostfolio is connected', () => {
    const off = buildToolGuide({ ghostfolio: 'not_configured' })
    expect(off.categories.flatMap(c => c.tools).some(t => t.name.startsWith('ghostfolio_'))).toBe(false)
    expect(off.notes.join(' ')).toMatch(/Ghostfolio/)

    const on = buildToolGuide({ ghostfolio: 'ok' })
    const ghost = on.categories.flatMap(c => c.tools).filter(t => t.name.startsWith('ghostfolio_'))
    expect(ghost).toHaveLength(GHOSTFOLIO_TOOL_ALLOWLIST.size)
    expect(on.notes).toEqual([])
  })

  it('says Ghostfolio is down rather than unconfigured when it is failing', () => {
    const guide = buildToolGuide({ ghostfolio: 'failing' })
    expect(guide.notes.join(' ')).toMatch(/not responding/i)
  })

  it('carries a one-line blurb for every category it shows', () => {
    for (const c of buildToolGuide({ ghostfolio: 'ok' }).categories) {
      expect(c.blurb.trim(), c.category).not.toBe('')
    }
  })

  it('lists every slash command, /tools first, with a usage line showing its arguments', () => {
    const { commands } = buildToolGuide({ ghostfolio: 'ok' })
    expect(commands[0]?.name).toBe('tools')
    expect(commands.map(c => c.name).sort()).toEqual([...SLASH_COMMANDS.map(c => c.name), 'tools'].sort())
    expect(commands.find(c => c.name === 'management-deep-dive')?.usage).toBe('/management-deep-dive <person> <symbol>')
    expect(commands.find(c => c.name === 'tools')?.usage).toBe('/tools')
  })
})

describe('isToolsGuideCommand', () => {
  it('matches /tools on its own, in any case, with surrounding space', () => {
    expect(isToolsGuideCommand('/tools')).toBe(true)
    expect(isToolsGuideCommand('  /TOOLS  ')).toBe(true)
  })

  it('does not match other text', () => {
    expect(isToolsGuideCommand('tools')).toBe(false)
    expect(isToolsGuideCommand('/toolsx')).toBe(false)
    expect(isToolsGuideCommand('/tools please explain')).toBe(false)
    expect(isToolsGuideCommand('what /tools do you have')).toBe(false)
  })

  it('is advertised in the palette entry shape', () => {
    expect(TOOLS_GUIDE_COMMAND).toMatchObject({ name: 'tools', args: [] })
    expect(TOOLS_GUIDE_COMMAND.description.length).toBeGreaterThan(0)
  })
})
