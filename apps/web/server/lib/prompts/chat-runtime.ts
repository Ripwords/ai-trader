import { DEFAULT_NOTIFICATION_SETTINGS } from '../../../types/notifications'
import { getNotificationSettings } from '../notification-settings'
import { getPrompt } from './index'

/** e.g. `Current date/time: Sat 17 Oct 2026 13:40 (Asia/Kuala_Lumpur, UTC+08:00).` */
export function formatCurrentDateTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    }).formatToParts(at).map(p => [p.type, p.value]),
  ) as Partial<Record<Intl.DateTimeFormatPartTypes, string>>
  // longOffset is "GMT+08:00", or bare "GMT" for UTC itself.
  const offset = (parts.timeZoneName ?? 'GMT').replace('GMT', 'UTC')
  const utcOffset = offset === 'UTC' ? 'UTC+00:00' : offset
  return `Current date/time: ${parts.weekday} ${parts.day} ${parts.month} ${parts.year} ${parts.hour}:${parts.minute} (${timeZone}, ${utcOffset}).`
}

export interface ChatPromptInputs {
  body: string
  moomooRules: string
  currentDateTime: string
}

/** The editable chat text plus the current time in the user's zone, for `buildSystemPrompt`. */
export async function loadChatPromptInputs(now: Date = new Date()): Promise<ChatPromptInputs> {
  const [body, moomooRules, settings] = await Promise.all([
    getPrompt('chat.system'),
    getPrompt('chat.moomoo_rules'),
    getNotificationSettings().catch((err: unknown) => {
      console.error('[chat] notification settings unreadable; using the default timezone', err)
      return DEFAULT_NOTIFICATION_SETTINGS
    }),
  ])
  return { body, moomooRules, currentDateTime: formatCurrentDateTime(now, settings.timezone) }
}
