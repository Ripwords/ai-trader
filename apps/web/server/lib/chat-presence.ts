import { z } from 'zod'

/**
 * Whether anyone is looking at a chat, so a finished reply knows to push.
 * Each open tab reports for the thread it shows and heartbeats while in
 * view; a closed tab just goes quiet, so a report older than the window
 * counts as nobody there.
 */
export const PRESENCE_FRESH_MS = 60_000

export const chatPresenceSchema = z.object({
  threadId: z.string().min(1).max(64),
  /** One per tab, so two tabs on the same chat don't overwrite each other. */
  clientId: z.string().min(1).max(64),
  away: z.boolean(),
})
export type ChatPresenceReport = z.infer<typeof chatPresenceSchema>

export interface Presence {
  away: boolean
  at: Date
}

/** Notify unless a fresh report says some client is viewing the chat, focused and visible. */
export function shouldNotifyReply(reports: readonly Presence[], now: Date): boolean {
  return !reports.some(r => !r.away && now.getTime() - r.at.getTime() <= PRESENCE_FRESH_MS)
}

export class ChatPresenceRegistry {
  private byClient = new Map<string, Presence & { threadId: string }>()

  get size(): number {
    return this.byClient.size
  }

  report(clientId: string, report: Omit<ChatPresenceReport, 'clientId'>, at: Date): void {
    for (const [id, p] of this.byClient) {
      if (at.getTime() - p.at.getTime() > PRESENCE_FRESH_MS) this.byClient.delete(id)
    }
    this.byClient.set(clientId, { threadId: report.threadId, away: report.away, at })
  }

  shouldNotify(threadId: string, now: Date): boolean {
    return shouldNotifyReply([...this.byClient.values()].filter(p => p.threadId === threadId), now)
  }
}

// One web process serves the app, so presence lives in its memory.
export const chatPresence = new ChatPresenceRegistry()
