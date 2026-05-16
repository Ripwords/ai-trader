export interface ConversationThread {
  id: string
  title: string
  createdAt: Date | string
  updatedAt: Date | string
}

export interface ConversationDecision {
  id: string
  title: string
  note?: string
  created_at: string
}

export interface ConversationMetadata {
  pinned: boolean
  archived: boolean
  summary?: string
  decisions: ConversationDecision[]
}

export interface ManagedConversation extends ConversationThread, ConversationMetadata {
  decision_count: number
}

export interface ConversationSearchResult extends ManagedConversation {
  match: {
    source: 'title' | 'summary' | 'decision' | 'message'
    snippet: string
  }
}

export interface ConversationSummaryResult {
  summary: string
  decision: Omit<ConversationDecision, 'id' | 'created_at'> | null
}

const DEFAULT_METADATA: ConversationMetadata = {
  pinned: false,
  archived: false,
  decisions: [],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const cleaned = value.trim().replace(/\s+/g, ' ')
  return cleaned || undefined
}

function normalizeDecision(input: unknown): ConversationDecision | null {
  if (!isRecord(input)) return null
  const id = cleanText(input.id)
  const title = cleanText(input.title)
  const createdAt = cleanText(input.created_at)
  if (!id || !title || !createdAt) return null
  return {
    id,
    title,
    note: cleanText(input.note),
    created_at: createdAt,
  }
}

export function normalizeConversationMetadata(input: unknown): ConversationMetadata {
  if (!isRecord(input)) return { ...DEFAULT_METADATA }
  return {
    pinned: input.pinned === true,
    archived: input.archived === true,
    summary: cleanText(input.summary),
    decisions: Array.isArray(input.decisions)
      ? input.decisions.flatMap(row => {
          const decision = normalizeDecision(row)
          return decision ? [decision] : []
        })
      : [],
  }
}

export function normalizeConversationMetadataMap(input: unknown): Record<string, ConversationMetadata> {
  if (!isRecord(input)) return {}
  const out: Record<string, ConversationMetadata> = {}
  for (const [id, value] of Object.entries(input)) {
    if (!isRecord(value)) continue
    out[id] = normalizeConversationMetadata(value)
  }
  return out
}

export function applyConversationMetadata(
  threads: ConversationThread[],
  metadataByThread: Record<string, ConversationMetadata>,
  opts: { includeArchived?: boolean } = {},
): ManagedConversation[] {
  return threads
    .map(thread => {
      const metadata = metadataByThread[thread.id] ?? DEFAULT_METADATA
      return {
        ...thread,
        ...metadata,
        decision_count: metadata.decisions.length,
      }
    })
    .filter(thread => opts.includeArchived || !thread.archived)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    })
}

export function extractMessageText(message: unknown): string {
  if (!isRecord(message)) return ''
  const parts = Array.isArray(message.parts) ? message.parts : []
  const chunks: string[] = []
  for (const part of parts) {
    if (!isRecord(part)) continue
    if (typeof part.text === 'string' && part.text.trim()) {
      chunks.push(part.text.trim())
      continue
    }
    if ('output' in part) {
      try {
        chunks.push(JSON.stringify(part.output))
      } catch {
        // Ignore unserializable tool outputs; chat messages stay searchable by text.
      }
    }
  }
  return chunks.join(' ').replace(/\s+/g, ' ').trim()
}

function includesAllTerms(haystack: string, query: string): boolean {
  const normalizedHaystack = haystack.toLowerCase()
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every(term => normalizedHaystack.includes(term))
}

function makeSnippet(text: string, query: string): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  const firstTerm = query.toLowerCase().split(/\s+/).find(Boolean)
  if (!firstTerm) return compact.slice(0, 180)
  const idx = compact.toLowerCase().indexOf(firstTerm)
  if (idx < 0 || compact.length <= 180) return compact.slice(0, 180)
  const start = Math.max(0, idx - 60)
  const end = Math.min(compact.length, idx + 120)
  return compact.slice(start, end)
}

export function searchConversationThreads(
  threads: ManagedConversation[],
  messagesByThread: Record<string, unknown[]>,
  query: string,
): ConversationSearchResult[] {
  const q = query.trim()
  if (!q) return []
  const results: ConversationSearchResult[] = []

  for (const thread of threads) {
    const decisionText = thread.decisions.map(d => `${d.title} ${d.note ?? ''}`).join(' ')
    const candidates: Array<ConversationSearchResult['match']> = [
      { source: 'title', snippet: thread.title },
      ...(thread.summary ? [{ source: 'summary' as const, snippet: thread.summary }] : []),
      ...(decisionText ? [{ source: 'decision' as const, snippet: decisionText }] : []),
      ...((messagesByThread[thread.id] ?? []).map(message => ({
        source: 'message' as const,
        snippet: extractMessageText(message),
      }))),
    ]
    const match = candidates.find(candidate => candidate.snippet && includesAllTerms(candidate.snippet, q))
    if (!match) continue
    results.push({
      ...thread,
      match: {
        source: match.source,
        snippet: makeSnippet(match.snippet, q),
      },
    })
  }

  return results
}

export function buildConversationSummary(thread: ConversationThread, messages: unknown[]): ConversationSummaryResult {
  const textMessages = messages.map(extractMessageText).filter(Boolean)
  const firstUser = textMessages[0] ?? thread.title
  const latestAssistant = [...textMessages].reverse().find(Boolean) ?? ''
  const summary = [firstUser, latestAssistant]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 360)

  const decisionMatch = latestAssistant.match(/\bdecision\s*:\s*([^.\n]+(?:\.[^\n]*)?)/i)
  return {
    summary,
    decision: decisionMatch?.[1]
      ? { title: decisionMatch[1].trim() }
      : null,
  }
}
