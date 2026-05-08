import { createTool } from '@mastra/core/tools'
import { ofetch } from 'ofetch'
import { z } from 'zod'

interface TavilyResponse {
  results: { title: string; url: string; content: string; published_date?: string }[]
}

async function tavilySearch(apiKey: string, query: string, topic: 'general' | 'news', maxResults: number) {
  return ofetch<TavilyResponse>('https://api.tavily.com/search', {
    method: 'POST',
    body: { api_key: apiKey, query, topic, max_results: maxResults, include_answer: false },
  })
}

const searchInputSchema = z.object({
  query: z.string(),
  maxResults: z.number().int().min(1).max(10).default(5),
})

export function makeSearchTools(apiKey: string) {
  const webSearch = createTool({
    id: 'search.web',
    description: 'Search the web for general information. Use for facts, definitions, recent context that isn\'t market data.',
    inputSchema: searchInputSchema,
    execute: async (inputData) => {
      const { query, maxResults } = searchInputSchema.parse(inputData)
      if (!apiKey) throw new Error('TAVILY_API_KEY not set')
      const r = await tavilySearch(apiKey, query, 'general', maxResults)
      return { results: r.results }
    },
  })

  const newsSearch = createTool({
    id: 'search.news',
    description: 'Search recent news. Use when the user asks about news, headlines, recent events for a company or market.',
    inputSchema: searchInputSchema,
    execute: async (inputData) => {
      const { query, maxResults } = searchInputSchema.parse(inputData)
      if (!apiKey) throw new Error('TAVILY_API_KEY not set')
      const r = await tavilySearch(apiKey, query, 'news', maxResults)
      return { results: r.results }
    },
  })

  return { webSearch, newsSearch }
}
