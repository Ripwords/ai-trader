import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import { getDb } from '../../../db/client'
import { pushSubscriptions } from '../../../db/schema'

/** The browser's PushSubscription.toJSON() shape, plus the user agent for the device list. */
export const pushSubscribeSchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(1).max(512),
    auth: z.string().min(1).max(256),
  }),
  userAgent: z.string().max(512).nullish(),
})

export type PushSubscribeInput = z.infer<typeof pushSubscribeSchema>

/** What the Settings device list shows. Keys never leave the server. */
export interface PushDevice {
  id: string
  endpointHost: string
  /** Last characters of the endpoint, so a browser can spot its own row. */
  endpointTail: string
  userAgent: string | null
  createdAt: string
  lastSuccessAt: string | null
}

function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  }
  catch {
    return 'unknown'
  }
}

/** Upsert on endpoint: re-subscribing the same browser refreshes its keys instead of adding a device. */
export async function savePushSubscription(input: PushSubscribeInput): Promise<string> {
  const values = {
    endpoint: input.endpoint,
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
    userAgent: input.userAgent ?? null,
  }
  const rows = await getDb()
    .insert(pushSubscriptions)
    .values(values)
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: values.p256dh, auth: values.auth, userAgent: values.userAgent },
    })
    .returning({ id: pushSubscriptions.id })
  if (!rows[0]) throw new Error('failed to save push subscription')
  return rows[0].id
}

export async function listPushDevices(): Promise<PushDevice[]> {
  const rows = await getDb().select().from(pushSubscriptions).orderBy(desc(pushSubscriptions.createdAt))
  return rows.map(r => ({
    id: r.id,
    endpointHost: endpointHost(r.endpoint),
    endpointTail: r.endpoint.slice(-16),
    userAgent: r.userAgent,
    createdAt: r.createdAt.toISOString(),
    lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
  }))
}

export async function listPushTargets() {
  return getDb()
    .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, p256dh: pushSubscriptions.p256dh, auth: pushSubscriptions.auth })
    .from(pushSubscriptions)
}

export async function deletePushSubscriptionById(id: string): Promise<boolean> {
  const rows = await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).returning({ id: pushSubscriptions.id })
  return rows.length > 0
}

export async function deletePushSubscriptionByEndpoint(endpoint: string): Promise<boolean> {
  const rows = await getDb().delete(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).returning({ id: pushSubscriptions.id })
  return rows.length > 0
}

export async function markPushSubscriptionOk(id: string, at: Date): Promise<void> {
  await getDb().update(pushSubscriptions).set({ lastSuccessAt: at }).where(eq(pushSubscriptions.id, id))
}

export async function countPushSubscriptions(): Promise<number> {
  const rows = await getDb().select({ id: pushSubscriptions.id }).from(pushSubscriptions)
  return rows.length
}
