import { webDefault, type WebPromptId } from './registry'
import { readPromptOverrides } from './store'

/** The prompt text to send: the Settings override when one is saved, else the default. */
export async function getPrompt(id: WebPromptId): Promise<string> {
  try {
    const overrides = await readPromptOverrides()
    return overrides[id] ?? webDefault(id)
  } catch (err) {
    console.error(`[prompts] could not read overrides; using the default for ${id}`, err)
    return webDefault(id)
  }
}
