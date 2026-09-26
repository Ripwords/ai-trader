import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const connectMock = vi.fn()
const listToolsMock = vi.fn()

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = connectMock
    listTools = listToolsMock
    close = vi.fn(async () => {})
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const loadMcp = () => import('../../server/llm/mcp')

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  connectMock.mockReset()
  listToolsMock.mockReset().mockResolvedValue({ tools: [{ name: 'get_accounts', description: 'accounts' }] })
  process.env.GHOSTFOLIO_MCP_URL = 'https://example.test/mcp'
  process.env.GHOSTFOLIO_MCP_BEARER = 'test-bearer'
})

afterEach(() => {
  vi.useRealTimers()
})

describe('ghostfolio MCP connect bounds', () => {
  it('gives up on a hanging connect after 3 s and reports failing', async () => {
    connectMock.mockReturnValue(new Promise(() => {}))
    const { getGhostfolioStatus, getGhostfolioTools } = await loadMcp()

    const status = getGhostfolioStatus()
    const tools = getGhostfolioTools()
    await vi.advanceTimersByTimeAsync(3000)

    expect(await status).toBe('failing')
    expect(await tools).toEqual({})
  })

  it('does not retry a failed connect for 60 s, then tries again', async () => {
    connectMock.mockRejectedValue(new Error('ECONNREFUSED'))
    const { getGhostfolioStatus } = await loadMcp()

    expect(await getGhostfolioStatus()).toBe('failing')
    expect(await getGhostfolioStatus()).toBe('failing')
    expect(connectMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(59_000)
    await getGhostfolioStatus()
    expect(connectMock).toHaveBeenCalledTimes(1)

    connectMock.mockResolvedValue(undefined)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await getGhostfolioStatus()).toBe('ok')
    expect(connectMock).toHaveBeenCalledTimes(2)
  })

  it('lists tools once and serves them from cache afterwards', async () => {
    connectMock.mockResolvedValue(undefined)
    const { getGhostfolioTools } = await loadMcp()

    expect(Object.keys(await getGhostfolioTools())).toEqual(['ghostfolio_get_accounts'])
    await getGhostfolioTools()
    expect(listToolsMock).toHaveBeenCalledTimes(1)
  })
})
