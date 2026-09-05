import { beforeEach, describe, expect, it, vi } from 'vitest'

// --- Mock the MCP SDK so we can drive callTool/listTools behaviour and count
// how many times a fresh client is connected (i.e. reconnects). ---
const connectMock = vi.fn().mockResolvedValue(undefined)
const callToolMock = vi.fn()
const listToolsMock = vi.fn()
let clientInstances = 0

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    constructor() {
      clientInstances++
    }
    connect = connectMock
    callTool = callToolMock
    listTools = listToolsMock
  },
}))

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

/** Mirror the server's real 404 failure: StreamableHTTPError(404, "...Session not found"). */
function sessionLostError(): Error {
  const err = new Error('Error POSTing to endpoint (HTTP 404): {"message":"Session not found"}')
  ;(err as Error & { code: number }).code = 404
  return err
}

type McpModule = typeof import('../../server/llm/mcp')
async function loadMcp(): Promise<McpModule> {
  return import('../../server/llm/mcp')
}

beforeEach(() => {
  vi.resetModules()
  connectMock.mockClear()
  callToolMock.mockReset()
  listToolsMock.mockReset()
  clientInstances = 0
  process.env.GHOSTFOLIO_MCP_URL = 'https://example.test/mcp'
  process.env.GHOSTFOLIO_MCP_BEARER = 'test-bearer'
})

describe('ghostfolio MCP session recovery', () => {
  it('reconnects and retries once when the server drops the session', async () => {
    callToolMock
      .mockRejectedValueOnce(sessionLostError())
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"ok":true}' }] })

    const { callGhostfolioTool } = await loadMcp()
    const result = await callGhostfolioTool('get_health', {})

    expect(result).toEqual({ ok: true })
    expect(callToolMock).toHaveBeenCalledTimes(2) // failed once, retried once
    expect(clientInstances).toBe(2) // reconnected with a fresh client
  })

  it('does not retry on non-session errors', async () => {
    callToolMock.mockRejectedValue(new Error('boom: bad request'))

    const { callGhostfolioTool } = await loadMcp()
    await expect(callGhostfolioTool('get_health', {})).rejects.toThrow('boom')
    expect(callToolMock).toHaveBeenCalledTimes(1) // no retry
    expect(clientInstances).toBe(1)
  })

  it('recovers a cached tool wrapper after a session drop (no stale captured client)', async () => {
    listToolsMock.mockResolvedValue({ tools: [{ name: 'get_portfolio_details', description: 'details' }] })
    callToolMock
      .mockRejectedValueOnce(sessionLostError())
      .mockResolvedValueOnce({ content: [{ type: 'text', text: '{"status":"ok"}' }] })

    const { getGhostfolioTools } = await loadMcp()
    const tools = await getGhostfolioTools()
    const wrapped = tools['ghostfolio_get_portfolio_details']
    expect(wrapped).toBeTruthy()

    const out = await wrapped!.execute!({}, {} as never)
    expect(out).toEqual({ status: 'ok' })
    expect(clientInstances).toBe(2) // wrapper resolved a fresh client, not the captured dead one
  })

  it('shares one in-flight connect between concurrent first callers', async () => {
    listToolsMock.mockResolvedValue({ tools: [] })
    const { getGhostfolioTools, getGhostfolioStatus } = await loadMcp()
    const [tools, status] = await Promise.all([getGhostfolioTools(), getGhostfolioStatus()])
    expect(tools).toEqual({})
    expect(status).toBe('ok')
    expect(clientInstances).toBe(1)
  })
})

describe('ghostfolio MCP tool exposure', () => {
  it('exposes only the read-only allowlist, never the write tools the server advertises', async () => {
    listToolsMock.mockResolvedValue({
      tools: [
        { name: 'get_portfolio_holdings', description: 'holdings' },
        { name: 'get_dividends', description: 'dividends' },
        { name: 'delete_account', description: 'delete' },
        { name: 'import_transactions', description: 'import' },
        { name: 'create_activity', description: 'create' },
        { name: 'transfer_account_balance', description: 'transfer' },
        { name: 'lookup_symbols', description: 'covered by native symbol resolution' },
        { name: 'get_health', description: 'noise' },
      ],
    })
    const { getGhostfolioTools, GHOSTFOLIO_TOOL_ALLOWLIST } = await loadMcp()
    const tools = await getGhostfolioTools()
    expect(Object.keys(tools).sort()).toEqual(['ghostfolio_get_dividends', 'ghostfolio_get_portfolio_holdings'])
    for (const name of GHOSTFOLIO_TOOL_ALLOWLIST) {
      expect(name.startsWith('get_')).toBe(true)
    }
  })
})
