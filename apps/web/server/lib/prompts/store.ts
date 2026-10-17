import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { appSettings } from '../../../db/schema'

/** `app_settings` row holding `{ [promptId]: text }`. No entry means the default. */
export const PROMPTS_SETTINGS_KEY = 'prompts'

const overridesSchema = z.record(z.string(), z.string())

export async function readPromptOverrides(): Promise<Record<string, string>> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, PROMPTS_SETTINGS_KEY))
    .limit(1)
  const parsed = overridesSchema.safeParse(rows[0]?.value ?? {})
  return parsed.success ? parsed.data : {}
}

/** Merged into the stored object in one statement, so two saves never drop each other. */
export async function writePromptOverride(id: string, text: string): Promise<void> {
  const entry = { [id]: text }
  await getDb()
    .insert(appSettings)
    .values({ key: PROMPTS_SETTINGS_KEY, value: entry })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: sql`${appSettings.value} || ${JSON.stringify(entry)}::jsonb`, updatedAt: new Date() },
    })
}

export async function deletePromptOverride(id: string): Promise<void> {
  await getDb()
    .update(appSettings)
    .set({ value: sql`${appSettings.value} - ${id}::text`, updatedAt: new Date() })
    .where(eq(appSettings.key, PROMPTS_SETTINGS_KEY))
}
