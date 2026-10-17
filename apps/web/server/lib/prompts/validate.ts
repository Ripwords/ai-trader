import type { PromptEngine } from '../../../types/prompts'

export const MAX_PROMPT_CHARS = 50_000

export type FieldParse = { ok: true; fields: string[] } | { ok: false; error: string }

const DOUBLE_HINT = 'Write {{ or }} for a literal brace.'

function excerpt(text: string, at: number): string {
  return JSON.stringify(text.slice(Math.max(0, at - 20), at + 20))
}

/**
 * The `{name}` fields of a Python `str.format` / LangChain f-string template,
 * following `string.Formatter.parse`: `{{` and `}}` are literal braces, a lone
 * `}` is an error, and a field runs to its matching `}` (format specs may nest
 * one level of braces). The field name is the part before `!`, `:`, `.` or `[`.
 */
export function parseTemplateFields(text: string): FieldParse {
  const fields: string[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '}') {
      if (text[i + 1] === '}') {
        i += 2
        continue
      }
      return { ok: false, error: `Single '}' near ${excerpt(text, i)}. ${DOUBLE_HINT}` }
    }
    if (ch !== '{') {
      i++
      continue
    }
    if (text[i + 1] === '{') {
      i += 2
      continue
    }
    let depth = 1
    let j = i + 1
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++
      else if (text[j] === '}') depth--
      if (depth > 0) j++
    }
    if (depth > 0) {
      return { ok: false, error: `Single '{' near ${excerpt(text, i)} is never closed. ${DOUBLE_HINT}` }
    }
    const inner = text.slice(i + 1, j)
    const name = inner.split(/[!:.[]/, 1)[0]!.trim()
    if (!name) {
      return { ok: false, error: `Empty placeholder {} near ${excerpt(text, i)}. ${DOUBLE_HINT}` }
    }
    if (!/^[A-Za-z_]\w*$/.test(name)) {
      return { ok: false, error: `"{${inner}}" is not a valid placeholder. ${DOUBLE_HINT}` }
    }
    if (!fields.includes(name)) fields.push(name)
    i = j + 1
  }
  return { ok: true, fields }
}

export interface PromptRules {
  engine: PromptEngine
  /** The placeholders the default uses; an override may use any subset. */
  placeholders: readonly string[]
  contract?: string
}

export type PromptCheck = { ok: true; warnings: string[] } | { ok: false; error: string }

export function validatePromptText(text: string, rules: PromptRules): PromptCheck {
  if (!text.trim()) return { ok: false, error: 'The prompt is empty. Use Reset to go back to the default.' }
  if (text.length > MAX_PROMPT_CHARS) {
    return { ok: false, error: `The prompt is ${text.length.toLocaleString('en-US')} characters; the limit is ${MAX_PROMPT_CHARS.toLocaleString('en-US')}.` }
  }
  if (rules.engine === 'agents') {
    const parsed = parseTemplateFields(text)
    if (!parsed.ok) return { ok: false, error: parsed.error }
    const unknown = parsed.fields.filter(f => !rules.placeholders.includes(f))
    if (unknown.length > 0) {
      const allowed = rules.placeholders.length
        ? `Allowed: ${rules.placeholders.map(p => `{${p}}`).join(', ')}.`
        : 'This prompt takes no placeholders.'
      return {
        ok: false,
        error: `Unknown placeholder ${unknown.map(f => `{${f}}`).join(', ')}. ${allowed} ${DOUBLE_HINT}`,
      }
    }
  }
  const warnings = rules.contract && !text.includes(rules.contract)
    ? [`The text no longer contains "${rules.contract}". The reply is parsed for it, so without it the result may be lost.`]
    : []
  return { ok: true, warnings }
}
