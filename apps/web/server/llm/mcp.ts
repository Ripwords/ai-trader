import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { tool, type Tool } from 'ai'
import { z } from 'zod'

// MCP tool args are dynamic (JSON Schema from the server), so we deliberately
// erase the type to align with how `streamText` consumes the merged tool record.
type McpTool = Tool

/** Cached singleton — opening an MCP connection is non-trivial; we don't
 *  want to do it per request. */
let _client: Client | null = null
let _toolsCache: Record<string, McpTool> | null = null

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
export async function getGhostfolioTools(): Promise<Record<string, McpTool>> {
  if (_toolsCache) return _toolsCache
  const client = await getClient()
  if (!client) return {}

  try {
    const list = await client.listTools()
    const out: Record<string, McpTool> = {}
    for (const t of list.tools) {
      const safeName = `ghostfolio_${t.name.replace(/[^a-zA-Z0-9_-]/g, '_')}`
      // MCP args are dynamic (JSON Schema from the server). Use a permissive
      // record schema and erase the inferred type so this tool slots into the
      // merged tool record alongside strictly-typed native tools.
      out[safeName] = tool({
        description: t.description || `Ghostfolio: ${t.name}`,
        inputSchema: z.record(z.string(), z.unknown()),
        execute: async (args: Record<string, unknown>) => {
          const result = await client.callTool({ name: t.name, arguments: args })
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
      }) as McpTool
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

export type GhostfolioStatus = 'ok' | 'failing' | 'not_configured'

/**
 * Tri-state Ghostfolio probe so callers can distinguish "user never set this
 * up" from "configured but the connection is broken right now". The chat
 * system prompt uses this to surface MCP failures explicitly to the agent.
 */
export async function getGhostfolioStatus(): Promise<GhostfolioStatus> {
  if (!process.env.GHOSTFOLIO_MCP_URL || !process.env.GHOSTFOLIO_MCP_BEARER) return 'not_configured'
  const client = await getClient()
  return client ? 'ok' : 'failing'
}

/**
 * Direct MCP tool invocation that bypasses the Vercel AI SDK wrapper. Used
 * by the holdings aggregator which needs raw tool calls (not chat-shaped
 * `tool()` definitions). Throws if the MCP is unavailable so callers can
 * catch and downgrade to a `failing` status.
 */
export async function callGhostfolioTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await getClient()
  if (!client) throw new Error('ghostfolio MCP unavailable')
  const result = await client.callTool({ name, arguments: args })
  const blocks = result.content as Array<{ type: string; text?: string; data?: unknown }>
  const text = blocks
    .filter(b => b.type === 'text' && b.text)
    .map(b => b.text!)
    .join('\n')
  if (text) {
    try { return JSON.parse(text) } catch { return { text } }
  }
  return result
}
