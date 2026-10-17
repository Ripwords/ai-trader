import { eq, sql } from 'drizzle-orm'
import { getDb } from '../../db/client'
import { appSettings } from '../../db/schema'
import type { HeartbeatEntry, SchedulerHeartbeat } from '../../types/scheduler'
import { createGuardedTick } from './guarded-tick'

/**
 * Glue between Nitro scheduled tasks and the heartbeat. Nitro's runTask
 * already refuses to start a task that is still running, but it waits on a
 * stuck run forever; createGuardedTick bounds each run so one hung await
 * can't stop a task until the next restart.
 */

export const HEARTBEAT_KEY = 'scheduler_heartbeat'

/** Merges this task's entry into the shared row in one statement, so concurrent tasks never overwrite each other. */
export async function recordHeartbeat(task: string, entry: HeartbeatEntry): Promise<void> {
  const value = { [task]: entry }
  await getDb()
    .insert(appSettings)
    .values({ key: HEARTBEAT_KEY, value })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: sql`${appSettings.value} || excluded.value`, updatedAt: new Date() },
    })
}

export async function getHeartbeat(): Promise<SchedulerHeartbeat> {
  const rows = await getDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, HEARTBEAT_KEY))
    .limit(1)
  const v = rows[0]?.value
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as SchedulerHeartbeat) : {}
}

export interface ScheduledJobOptions {
  timeoutMs: number
  record?: (task: string, entry: HeartbeatEntry) => Promise<void>
}

/** A run that never throws, never overlaps itself, and leaves a heartbeat either way. */
export function createScheduledJob(task: string, run: () => Promise<void>, opts: ScheduledJobOptions): () => Promise<void> {
  const record = opts.record ?? recordHeartbeat
  const beat = (lastOk: boolean, lastError: string | null) =>
    record(task, { lastRunAt: new Date().toISOString(), lastOk, lastError }).catch((err: unknown) => {
      console.error(`[scheduler] ${task}: heartbeat write failed`, err instanceof Error ? err.message : err)
    })

  return createGuardedTick(async () => {
    try {
      await run()
      await beat(true, null)
    }
    catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[scheduler] ${task} failed`, msg)
      await beat(false, msg)
    }
  }, opts.timeoutMs, () => {
    console.error(`[scheduler] ${task} timed out; the next tick starts fresh`)
    void beat(false, `timed out after ${Math.round(opts.timeoutMs / 1000)}s`)
  })
}
