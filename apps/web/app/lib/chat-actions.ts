import { isTextUIPart, type UIMessage } from 'ai'

/** What Copy puts on the clipboard: the reply's prose, not its reasoning or tool cards. */
export function copyableText(message: UIMessage): string {
  return message.parts
    .filter(isTextUIPart)
    .map(p => p.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/** The id to resend as an edit, or undefined to send a new question when the edited one is no longer in the thread. */
export function editTarget(messages: UIMessage[], editingId: string | null): string | undefined {
  if (!editingId) return undefined
  return messages.some(m => m.id === editingId && m.role === 'user') ? editingId : undefined
}

/** Whether a reply changed the moomoo watchlist, so the sidebar should reload it. */
export function changedWatchlist(message: UIMessage | undefined): boolean {
  return !!message?.parts.some(p =>
    (p.type === 'tool-watchlist_add' || p.type === 'tool-watchlist_remove')
    && 'state' in p && p.state === 'output-available')
}
