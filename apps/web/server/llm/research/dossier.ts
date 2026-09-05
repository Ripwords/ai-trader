import {
  resolveSymbol, getFinancialMetrics, getHistorical, getQuarterlyHistory,
  getEarningsInfo, getInsiderTrades, getDailyBars,
} from '../../lib/yahoo'
import { getContextualNews } from '../../lib/contextual-news'
import { getLatestRunForSymbol, getRunAssessment } from '../../lib/agents/runs-query'
import { searchWithFallback } from '../../lib/search'
import { getHoldingForSymbol } from '../../lib/holdings'
import { computeTechnicals, type TechnicalsSnapshot } from './technicals'

export type ResearchPreset = 'research' | 'team' | 'series' | 'management'
export interface DossierSection<T> { ok: boolean; note?: string; data: T | null }
export type AgentsVerdictData = { runId: string; rating: string | null; confidence: number | null; rationale: string | null; finishedAt: string | null }
export interface ResearchDossier {
  symbol: string; companyName: string; preset: ResearchPreset; part?: number
  valuation: DossierSection<unknown>
  fundamentals: DossierSection<{ metrics: unknown; annual: unknown; quarterly: unknown; earnings: unknown }>
  technicals: DossierSection<TechnicalsSnapshot>
  insider: DossierSection<unknown>
  news: DossierSection<unknown>
  holdings: DossierSection<unknown>
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

  const [valuation, fundamentals, technicals, insider, news, holdings, agentsVerdict, managementWeb] = await Promise.all([
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
    section('technicals', async () => computeTechnicals(await getDailyBars(symbol))),
    section('insider', () => getInsiderTrades(symbol)),
    section('news', async () => {
      const news = await getContextualNews({ symbol, companyName, maxResults: 10 })
      // getContextualNews never throws; a total search outage arrives as an
      // error string with every group empty, which must count as a missing
      // section so the memo states the gap instead of reporting "no news".
      if (news.error && news.ticker.length === 0 && news.macro.length === 0 && news.contextual.length === 0) {
        throw new Error(`news search failed: ${news.error}`)
      }
      return news
    }),
    section('holdings', () => getHoldingForSymbol(symbol)),
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
    valuation, fundamentals, technicals, insider, news, holdings, agentsVerdict,
    dataQuality: { full: missing.length === 0, missing },
  }
  if (managementWeb) dossier.managementWeb = managementWeb
  return dossier
}
