import { generateText } from 'ai'
import { resolveModel } from '../llm/model'
import { retitleThread } from '../db/repo'
import { recordUsageSafely } from './llm-cost'
import { getPrompt } from './prompts'

const MAX_TITLE = 60

/** The model's answer as a title, or null when it is empty or ran on past a title's length. */
export function cleanTitle(raw: string): string | null {
  const title = raw
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')
    .replace(/[.。!?:;,\s]+$/, '')
    .trim()
  if (!title || title.length > MAX_TITLE) return null
  return title
}

/**
 * New threads start titled with the truncated question. Swap that for a short
 * name from the quick model. Runs beside the reply and never throws into it:
 * on any failure the question stays as the title.
 */
export async function nameThread(threadId: string, question: string, defaultTitle: string): Promise<void> {
  try {
    const resolved = await resolveModel('quick')
    const { text, usage } = await generateText({
      model: resolved.model,
      system: await getPrompt('chat.title'),
      prompt: question.slice(0, 2000),
      // Room for a reasoning model's thinking before the few words of the title.
      maxOutputTokens: 600,
      abortSignal: AbortSignal.timeout(15_000),
    })
    if (usage) {
      await recordUsageSafely({
        source: 'chat-title',
        modelSpec: resolved.spec,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      })
    }
    const title = cleanTitle(text)
    if (title && title !== defaultTitle) await retitleThread(threadId, defaultTitle, title)
  } catch (err) {
    console.warn('[chat] could not name the thread; keeping the question as its title', err)
  }
}
