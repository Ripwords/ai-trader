import {
  resolveSymbol, getFinancialMetrics, getHistorical, getQuarterlyHistory,
  getEarningsInfo, getInsiderTrades,
} from '../../lib/yahoo'
import { getContextualNews } from '../../lib/contextual-news'
import { getLatestRunForSymbol, getRunAssessment } from '../../lib/agents/runs-query'
import { searchWithFallback } from '../../lib/search'

export type ResearchPreset = 'research' | 'team' | 'series' | 'management'
export interface DossierSection<T> { ok: boolean; note?: string; data: T | null }
export type AgentsVerdictData = { runId: string; rating: string | null; confidence: number | null; rationale: string | null; finishedAt: string | null }
export interface ResearchDossier {
  symbol: string; companyName: string; preset: ResearchPreset; part?: number
  valuation: DossierSection<unknown>
  fundamentals: DossierSection<{ metrics: unknown; annual: unknown; quarterly: unknown; earnings: unknown }>
  insider: DossierSection<unknown>
  news: DossierSection<unknown>
  agentsVerdict: DossierSection<AgentsVerdictData>
  managementWeb?: DossierSection<unknown>
  dataQuality: { full: boolean; missing: string[] }
}
export interface BuildDossierOpts {
  preset: ResearchPreset; person?: string; part?: number
  userId: string; baseUrl: string; sessionCookie?: string
}
export type DossierResolutionError = { error: 'unresolved'; resolution: unknown }

function ok<T>(data: T): DossierSection<T> { return { ok: true, data } }
function fail<T>(note: string): DossierSection<T> { return { ok: false, note, data: null } }

async function section<T>(label: string, fn: () => Promise<T>): Promise<DossierSection<T>> {
  try { return ok(await fn()) } catch (e) { return fail<T>(`${label} unavailable: ${(e as Error)?.message ?? 'error'}`) }
}

export async function buildResearchDossier(
  symbolInput: string, opts: BuildDossierOpts,
): Promise<ResearchDossier | DossierResolutionError> {
  const resolution = await resolveSymbol(symbolInput)
  if (resolution.status !== 'resolved') return { error: 'unresolved', resolution }
  const symbol = resolution.symbol
  const companyName = resolution.name

  const [valuation, fundamentals, insider, news, agentsVerdict, managementWeb] = await Promise.all([
    section('valuation', async () => {
      const res = await fetch(`${opts.baseUrl}/api/research/valuation?symbol=${encodeURIComponent(symbol)}`, {
        headers: { ...(opts.sessionCookie ? { cookie: opts.sessionCookie } : {}) },
      })
      if (!res.ok) throw new Error(`valuation ${res.status}`)
      return res.json()
    }),
    section('fundamentals', async () => ({
      metrics: await getFinancialMetrics(symbol),
      annual: await getHistorical(symbol),
      quarterly: await getQuarterlyHistory(symbol),
      earnings: await getEarningsInfo(symbol),
    })),
    section('insider', () => getInsiderTrades(symbol)),
    section('news', () => getContextualNews({ symbol, companyName, maxResults: 10 })),
    (async (): Promise<DossierSection<AgentsVerdictData>> => {
      try {
        const latest = await getLatestRunForSymbol(opts.userId, symbol)
        if (!latest) return fail('no recent agents run — say "run the agents" to add a fresh verdict')
        const a = await getRunAssessment(opts.userId, latest.runId)
        if (!a) return fail('no recent agents run — say "run the agents" to add a fresh verdict')
        return ok({ runId: a.runId, rating: a.rating, confidence: a.confidence, rationale: a.rationale, finishedAt: a.finishedAt })
      } catch (e) { return fail(`agents verdict unavailable: ${(e as Error)?.message ?? 'error'}`) }
    })(),
    opts.preset === 'management'
      ? section('management web', () => searchWithFallback(
          'web',
          `${opts.person ?? companyName} ${companyName} CEO founder track record capital allocation`,
          10,
        ))
      : Promise.resolve(undefined),
  ])

  const dataSections: Record<string, DossierSection<unknown>> = { valuation, fundamentals, insider, news }
  const missing = Object.entries(dataSections).filter(([, s]) => !s.ok).map(([k]) => k)

  const dossier: ResearchDossier = {
    symbol, companyName, preset: opts.preset, part: opts.part,
    valuation, fundamentals, insider, news, agentsVerdict,
    dataQuality: { full: missing.length === 0, missing },
  }
  if (managementWeb) dossier.managementWeb = managementWeb
  return dossier
}
