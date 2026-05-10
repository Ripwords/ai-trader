/**
 * Web/news search with provider fallback (Brave → Tavily, or vice versa).
 *
 * Extracted from server/llm/tools.ts so both chat tools and the /internal/news/*
 * routes (used by the Python TradingAgents toolkit) can share the same helper.
 */

export interface NewsResult {
  title: string
  url: string
  content: string
  published_date?: string
}

export type SearchKind = 'web' | 'news'

/**
 * Try the primary search provider first, fall back to the other. Picks
 * primary from process.env.SEARCH_PROVIDER ('brave' | 'tavily', default
 * 'brave'). A provider with no API key is skipped silently. If both
 * providers fail, throws the last error so the agent can surface it.
 */
export async function searchWithFallback(
  kind: SearchKind,
  query: string,
  maxResults: number,
): Promise<NewsResult[]> {
  const primary = (process.env.SEARCH_PROVIDER as 'brave' | 'tavily' | undefined) || 'brave'
  const order: ('brave' | 'tavily')[] = primary === 'tavily' ? ['tavily', 'brave'] : ['brave', 'tavily']

  let lastErr: unknown
  for (const provider of order) {
    const key = provider === 'brave' ? process.env.BRAVE_API_KEY : process.env.TAVILY_API_KEY
    if (!key) continue
    try {
      const results = provider === 'brave'
        ? await braveSearch(key, kind, query, maxResults)
        : await tavilySearch(key, kind, query, maxResults)
      if (results.length > 0) return results
    } catch (err) {
      lastErr = err
    }
  }
  if (lastErr) throw lastErr
  throw new Error('No search provider configured. Set BRAVE_API_KEY and/or TAVILY_API_KEY.')
}

interface BraveWebResponse {
  web?: { results?: { title: string; url: string; description: string; age?: string; page_age?: string }[] }
}
interface BraveNewsResponse {
  results?: { title: string; url: string; description: string; age?: string; page_age?: string }[]
}

async function braveSearch(apiKey: string, kind: SearchKind, query: string, maxResults: number): Promise<NewsResult[]> {
  const { ofetch } = await import('ofetch')
  const url = kind === 'news'
    ? 'https://api.search.brave.com/res/v1/news/search'
    : 'https://api.search.brave.com/res/v1/web/search'
  const raw = await ofetch<BraveWebResponse | BraveNewsResponse>(url, {
    query: { q: query, count: maxResults },
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
  })
  const items = kind === 'news'
    ? (raw as BraveNewsResponse).results ?? []
    : (raw as BraveWebResponse).web?.results ?? []
  return items.slice(0, maxResults).map(r => ({
    title: r.title,
    url: r.url,
    content: r.description,
    published_date: r.page_age || r.age,
  }))
}

interface TavilyResponse {
  results: { title: string; url: string; content: string; published_date?: string }[]
}

async function tavilySearch(apiKey: string, kind: SearchKind, query: string, maxResults: number): Promise<NewsResult[]> {
  const { ofetch } = await import('ofetch')
  const r = await ofetch<TavilyResponse>('https://api.tavily.com/search', {
    method: 'POST',
    body: {
      api_key: apiKey,
      query,
      topic: kind === 'news' ? 'news' : 'general',
      max_results: maxResults,
      include_answer: false,
    },
  })
  return r.results.map(x => ({
    title: x.title,
    url: x.url,
    content: x.content,
    published_date: x.published_date,
  }))
}
