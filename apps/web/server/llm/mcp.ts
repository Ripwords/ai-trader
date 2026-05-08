import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tool } from 'ai'
import { z } from 'zod'

/** Cached singleton — opening an MCP connection is non-trivial; we don't
 *  want to do it per request. */
let _client: Client | null = null
let _toolsCache: Record<string, ReturnType<typeof tool>> | null = null

async function getClient(): Promise<Client | null> {
  if (_client) return _client
  const url = process.env.GHOSTFOLIO_MCP_URL
  const bearer = process.env.GHOSTFOLIO_MCP_BEARER
  if (!url || !bearer) return null
  try {
    const transport = new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { Authorization: `Bearer ${bearer}` } },
    })
    const client = new Client({ name: 'ai-trader', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    _client = client
    return client
  } catch (err) {
    console.warn('[mcp] ghostfolio connect failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/**
 * Discovers tools exposed by the ghostfolio MCP server and wraps each one
 * as a Vercel AI SDK `tool()` so the agent can call them as if they were
 * native. Tool names are prefixed with `ghostfolio_` to make their origin
 * clear in the chat UI.
 *
 * Returns {} if Ghostfolio isn't configured — the agent simply doesn't
 * see those tools and can't invent calls to them.
 */
export async function getGhostfolioTools(): Promise<Record<string, ReturnType<typeof tool>>> {
  if (_toolsCache) return _toolsCache
  const client = await getClient()
  if (!client) return {}

  try {
    const list = await client.listTools()
    const out: Record<string, ReturnType<typeof tool>> = {}
    for (const t of list.tools) {
      const safeName = `ghostfolio_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      out[safeName] = tool({
        description: t.description || `Ghostfolio: ${t.name}`,
        // MCP returns JSON Schema; we coerce to a permissive zod object so the
        // SDK accepts arbitrary args. The MCP server validates the actual
        // arguments server-side anyway.
        inputSchema: z.record(z.string(), z.unknown()),
        execute: async (args) => {
          const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> })
          // MCP returns content blocks; prefer text, otherwise stringified JSON
          const blocks = result.content as Array<{ type: string; text?: string; data?: unknown }>
          const text = blocks
            .filter(b => b.type === 'text' && b.text)
            .map(b => b.text!)
            .join('\n')
          if (text) {
            try { return JSON.parse(text) } catch { return { text } }
          }
          return result
        },
      })
    }
    _toolsCache = out
    return out
  } catch (err) {
    console.warn('[mcp] ghostfolio listTools failed:', err instanceof Error ? err.message : String(err))
    return {}
  }
}

/** Force a reconnect on next call — useful if the user rotates credentials. */
export function resetMcp() {
  _client = null
  _toolsCache = null
}
