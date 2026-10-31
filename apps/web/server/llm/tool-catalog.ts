import type { GhostfolioStatus } from './mcp'
import type { makeTools } from './tools'
import { SLASH_COMMANDS, type SlashArg } from './research/commands'
import type { ToolGuide, ToolGuideCategory, ToolGuideCommand } from '../../types/tool-guide'

/**
 * What every chat tool is for, in the user's words. The /tools guide is built
 * from this, so it is the one place to describe a tool to a person (the
 * description in tools.ts is for the model).
 *
 * TOOL_CATALOG is keyed by the tools makeTools returns: adding, renaming or
 * removing a tool there is a type error here until its entry follows, and
 * tests/unit/tool-catalog.test.ts checks the same at runtime.
 */

/** Display order of the guide. */
export const TOOL_CATEGORIES = [
  'Portfolio',
  'Broker account',
  'Trading',
  'Market data',
  'Research',
  'Agent research runs',
  'News & web',
  'Watchlist',
  'Alerts & reminders',
  'Algo trading',
  'Ghostfolio tracker',
  'Utilities',
] as const

export type ToolCategory = typeof TOOL_CATEGORIES[number]

export const CATEGORY_BLURBS: Record<ToolCategory, string> = {
  'Portfolio': 'How your investments are doing: today\'s move, history, what you own and how it is spread.',
  'Broker account': 'Raw moomoo account data: accounts, positions, cash, orders and fills, paper or live.',
  'Trading': 'Place, change or cancel orders. Paper by default; live orders need a typed confirmation.',
  'Market data': 'Prices, charts and order-book depth for one symbol.',
  'Research': 'Dig into one company: valuation, technicals, a full memo, or a sharp question.',
  'Agent research runs': 'The multi-agent analyst and debate pipeline that gives a rated verdict.',
  'News & web': 'Headlines on a stock or a theme, and general web search.',
  'Watchlist': 'Read and edit your moomoo watchlist.',
  'Alerts & reminders': 'Price alerts and timed reminders, delivered by email and push.',
  'Algo trading': 'Your paper-trading strategies: backtest, watch signals, and the kill switch.',
  'Ghostfolio tracker': 'Net worth across every account you track in Ghostfolio, read-only.',
  'Utilities': 'Currency conversion and what the assistant has cost you.',
}

export interface ToolCatalogEntry {
  category: ToolCategory
  /** One line: what it does. */
  what: string
  /** One line: the situation it is the right tool for. */
  useWhen: string
  /** A prompt the user can type to reach it. */
  example: string
  /** Slash commands (no leading slash) that dispatch straight to this tool. */
  slash?: readonly string[]
}

type NativeToolName = keyof ReturnType<typeof makeTools>

export const TOOL_CATALOG: Record<NativeToolName, ToolCatalogEntry> = {
  // --- Portfolio ---------------------------------------------------------
  investment_portfolio: {
    category: 'Portfolio',
    what: 'Your live moomoo positions with today\'s move, unrealized P&L and per-currency totals.',
    useWhen: 'You ask how your portfolio is doing, what moved today, or what you hold.',
    example: 'How did my portfolio do today?',
  },
  investment_performance: {
    category: 'Portfolio',
    what: 'Your investments over time from daily snapshots: value, P&L, drawdown, 1/7/30-day change.',
    useWhen: 'You ask how your investments did this week, this month, or since you started.',
    example: 'How have my investments done this month?',
  },
  portfolio_performance: {
    category: 'Portfolio',
    what: 'Total net worth over time (every Ghostfolio account, cash included) from daily snapshots.',
    useWhen: 'You ask about net worth or total assets over time, not investment returns.',
    example: 'How has my net worth changed this year?',
  },
  holdings_context: {
    category: 'Portfolio',
    what: 'How much of one symbol you own: live, paper and tracker quantities, allocation and cash.',
    useWhen: 'You ask whether you own something, how many shares, or before sizing a trade.',
    example: 'How many NVDA shares do I have?',
  },
  portfolio_mpt_analysis: {
    category: 'Portfolio',
    what: 'Modern Portfolio Theory view: expected return, volatility, Sharpe, efficient frontier, correlations.',
    useWhen: 'You want to see risk, diversification or how your holdings move together.',
    example: 'Show my portfolio correlation heatmap',
  },

  // --- Broker account ----------------------------------------------------
  trade_accounts: {
    category: 'Broker account',
    what: 'Lists your moomoo accounts, paper and live, with their ids.',
    useWhen: 'You want to know which accounts exist, or an order needs a specific account.',
    example: 'Which moomoo accounts do I have?',
  },
  trade_account_overview: {
    category: 'Broker account',
    what: 'Cash, market value and total assets across every usable account in one environment.',
    useWhen: 'You ask about buying power or account-level exposure, live or paper.',
    example: 'How much buying power do I have in paper?',
  },
  trade_portfolio: {
    category: 'Broker account',
    what: 'Positions and cash in one moomoo account, shown as a portfolio card.',
    useWhen: 'You want one account\'s positions, especially the paper account.',
    example: 'Show my paper account positions',
  },
  trade_orders: {
    category: 'Broker account',
    what: 'Orders for an account: today\'s by default, or history for a date range or symbol.',
    useWhen: 'You ask what orders are open or what you ordered last week.',
    example: 'What orders did I place last week?',
  },
  trade_fills: {
    category: 'Broker account',
    what: 'Executed trades for an account: today\'s by default, or history for a date range or symbol.',
    useWhen: 'You ask what actually executed, rather than what was ordered.',
    example: 'What trades filled last month?',
  },

  // --- Trading -----------------------------------------------------------
  trade_place_order: {
    category: 'Trading',
    what: 'Places a limit, market, stop or stop-limit order. Paper unless you confirm live in words.',
    useWhen: 'You want to buy or sell. Live orders need the exact LIVE PLACE phrase it gives you.',
    example: 'Buy 10 NVDA at 120 in paper',
  },
  trade_modify_order: {
    category: 'Trading',
    what: 'Changes the price, quantity or trigger of an open order.',
    useWhen: 'You want to move a limit or stop on an order that has not filled.',
    example: 'Move my open NVDA paper order to 118',
  },
  trade_cancel_order: {
    category: 'Trading',
    what: 'Cancels an open order.',
    useWhen: 'You want an unfilled order gone.',
    example: 'Cancel my open NVDA paper order',
  },

  // --- Market data -------------------------------------------------------
  market_kline: {
    category: 'Market data',
    what: 'Candlestick bars for a symbol, drawn as a chart. Falls back to delayed Yahoo data.',
    useWhen: 'You want a chart or the recent price history.',
    example: 'Show me NVDA daily',
  },
  market_snapshot: {
    category: 'Market data',
    what: 'The latest quote: last price, change and volume.',
    useWhen: 'You want the price right now.',
    example: 'What is TSLA trading at?',
  },
  market_order_book: {
    category: 'Market data',
    what: 'Bid and ask depth for a symbol.',
    useWhen: 'You ask about the spread, liquidity or best bid and ask.',
    example: 'Show the order book for HK.00700',
  },

  // --- Research ----------------------------------------------------------
  investment_research: {
    category: 'Research',
    what: 'A research memo built from valuation, fundamentals, technicals, news, insiders and your holdings.',
    useWhen: 'You want a full write-up on a company. Fast: it reuses data and starts no agents run.',
    example: 'Give me a deep dive on NVDA',
    slash: ['investment-research', 'investment-team', 'deep-company-series', 'management-deep-dive'],
  },
  value_stock: {
    category: 'Research',
    what: 'A DCF valuation: fair value, margin of safety, three scenarios and implied growth.',
    useWhen: 'You ask whether a stock is cheap, expensive, or what it is worth.',
    example: 'Is AAPL undervalued?',
  },
  value_screen: {
    category: 'Research',
    what: 'Ranks your watchlist, or a list you give, by DCF margin of safety.',
    useWhen: 'You want the cheapest names among the stocks you follow.',
    example: 'Which stocks on my watchlist are cheapest?',
  },
  earnings_release: {
    category: 'Research',
    what: 'The latest earnings press release from SEC EDGAR: segments, one-off gains, FX, cash flow vs capex, guidance, with the filing link.',
    useWhen: 'A company just reported, or you want to know why revenue, EPS or free cash flow moved.',
    example: 'Why did Amazon\'s EPS fall even though operating income grew?',
  },
  earnings_call_transcript: {
    category: 'Research',
    what: 'The earnings call: management\'s prepared remarks and the analyst Q&A, with a sentiment score per speaker.',
    useWhen: 'You want the why behind a quarter in management\'s words, or what analysts pressed them on. Uses the Alpha Vantage daily budget (25).',
    example: 'What did Amazon management say about AWS capacity on the last call?',
  },
  estimate_revisions: {
    category: 'Research',
    what: 'How analyst EPS and revenue estimates have moved over 7/30/90 days, and the consensus before each recent print.',
    useWhen: 'You want to know if the street is raising or cutting numbers, or whether revenue beat expectations. Uses the Alpha Vantage daily budget (25).',
    example: 'Are analysts raising AMZN estimates after the quarter?',
  },
  earnings_surprise: {
    category: 'Research',
    what: 'Reported vs analyst consensus EPS for recent quarters, plus next-quarter estimates and revisions.',
    useWhen: 'You want to know whether a company beat or missed, and what the street expects next.',
    example: 'Did AMZN beat estimates last quarter?',
  },
  technical_analysis: {
    category: 'Research',
    what: 'Indicator snapshot: moving averages, MACD, RSI, Bollinger, ATR, support and resistance.',
    useWhen: 'You ask about the chart setup, overbought or oversold, or key levels.',
    example: 'Is TSLA overbought?',
    slash: ['technical-analysis', 'ta'],
  },
  dyp_ask: {
    category: 'Research',
    what: 'A first-principles answer to one pointed investment question, grounded in the app\'s data.',
    useWhen: 'You have a sharp question, not a request for a report.',
    example: 'Where is PDD\'s moat really?',
    slash: ['dyp-ask'],
  },
  thesis_tracker: {
    category: 'Research',
    what: 'Your research history on a symbol: latest verdict, confidence trend and whether it is stale.',
    useWhen: 'You want to know if your view on a stock still holds or needs a fresh run.',
    example: 'How is my thesis on NVDA holding up?',
    slash: ['thesis-tracker'],
  },

  // --- Agent research runs -----------------------------------------------
  agents_debate: {
    category: 'Agent research runs',
    what: 'Runs the analyst, bull/bear debate, trader and risk pipeline here in the chat, with progress.',
    useWhen: 'You want to watch the agents deliberate and wait for the verdict now.',
    example: 'Run the agents on NVDA',
  },
  research_start: {
    category: 'Agent research runs',
    what: 'Starts the same agents pipeline in the background and notifies you when it finishes.',
    useWhen: 'You want a rated verdict but would rather keep chatting while it runs.',
    example: 'Research AMD in the background',
  },
  research_get: {
    category: 'Agent research runs',
    what: 'The verdict of an agents run, or its progress while it is still running.',
    useWhen: 'You ask whether a run is done, or what the agents concluded on a symbol.',
    example: 'What did the agents conclude on AMD?',
  },

  // --- News & web --------------------------------------------------------
  news_pulse: {
    category: 'News & web',
    what: 'News on a stock plus the macro, sector and peer news that explains why it moved.',
    useWhen: 'You ask for the news on a stock or why it rose or fell.',
    example: 'Why did NVDA drop today?',
    slash: ['news-pulse'],
  },
  search_news: {
    category: 'News & web',
    what: 'Recent news on a topic that is not one stock: a sector, a theme, an event.',
    useWhen: 'You ask about a sector, the macro picture or an event.',
    example: 'Latest news on semiconductor export rules',
  },
  search_web: {
    category: 'News & web',
    what: 'General web search for facts, definitions and background.',
    useWhen: 'You need information that is not market data or news.',
    example: 'What is a reverse DCF?',
  },

  // --- Watchlist ---------------------------------------------------------
  watchlist_list: {
    category: 'Watchlist',
    what: 'The symbols on your moomoo watchlist.',
    useWhen: 'You ask what you are watching.',
    example: 'What\'s on my watchlist?',
  },
  watchlist_add: {
    category: 'Watchlist',
    what: 'Adds a symbol to your watchlist.',
    useWhen: 'You want to start following a stock.',
    example: 'Add AMD to my watchlist',
  },
  watchlist_remove: {
    category: 'Watchlist',
    what: 'Removes a symbol from your watchlist.',
    useWhen: 'You want to stop following a stock.',
    example: 'Remove AMD from my watchlist',
  },

  // --- Alerts & reminders ------------------------------------------------
  alert_create: {
    category: 'Alerts & reminders',
    what: 'A price alert: above a level, below a level, or a day move bigger than a percentage.',
    useWhen: 'You want to hear when a price crosses something.',
    example: 'Notify me when NVDA hits 150',
  },
  alert_list: {
    category: 'Alerts & reminders',
    what: 'Your price alerts: armed by default, or triggered and cancelled ones.',
    useWhen: 'You ask which alerts you have set.',
    example: 'What alerts do I have?',
  },
  alert_cancel: {
    category: 'Alerts & reminders',
    what: 'Cancels an armed price alert.',
    useWhen: 'You no longer want an alert.',
    example: 'Remove my NVDA alert',
  },
  reminder_create: {
    category: 'Alerts & reminders',
    what: 'A one-off reminder at a date and time, in your timezone.',
    useWhen: 'You want a nudge at a time, not on a price.',
    example: 'Remind me to check NVDA earnings on Friday at 9am',
  },
  reminder_list: {
    category: 'Alerts & reminders',
    what: 'Your reminders with their due times: upcoming by default, or sent and cancelled ones.',
    useWhen: 'You ask what reminders are coming up.',
    example: 'What reminders do I have?',
  },
  reminder_cancel: {
    category: 'Alerts & reminders',
    what: 'Cancels a reminder that has not fired yet.',
    useWhen: 'You no longer need a reminder.',
    example: 'Cancel my NVDA earnings reminder',
  },

  // --- Algo trading ------------------------------------------------------
  algo_list: {
    category: 'Algo trading',
    what: 'The algo strategies you have written.',
    useWhen: 'You ask what strategies you have, or before backtesting one.',
    example: 'What algo strategies do I have?',
  },
  algo_backtest: {
    category: 'Algo trading',
    what: 'Backtests a strategy on recent daily bars: equity curve, trades, P&L, win rate, drawdown.',
    useWhen: 'You want to know how a strategy would have done. Places no orders.',
    example: 'Backtest my NVDA momentum strategy',
  },
  algo_recent_signals: {
    category: 'Algo trading',
    what: 'Recent signals the scheduler fired, with the paper order or the reason it did not place.',
    useWhen: 'You ask what your algos have been doing.',
    example: 'What signals have my algos fired today?',
  },
  algo_state: {
    category: 'Algo trading',
    what: 'Whether the kill switch is on and which strategies are live.',
    useWhen: 'You ask whether the algos are running.',
    example: 'Are my algos running?',
  },
  algo_kill: {
    category: 'Algo trading',
    what: 'Turns on the kill switch: no algo orders are placed until you release it.',
    useWhen: 'Something looks wrong and you want every algo to stop placing orders now.',
    example: 'Kill all algos',
  },
  algo_unkill: {
    category: 'Algo trading',
    what: 'Releases the kill switch so enabled strategies trade again.',
    useWhen: 'You are ready for the algos to resume.',
    example: 'Resume the algos',
  },

  // --- Utilities ---------------------------------------------------------
  convert_fx: {
    category: 'Utilities',
    what: 'Converts an amount between currencies at the live rate.',
    useWhen: 'You need a figure in another currency.',
    example: 'Convert 5000 USD to MYR',
  },
  usage_summary: {
    category: 'Utilities',
    what: 'What the AI models have cost you today and this week, by source, and how many Alpha Vantage data calls are left today.',
    useWhen: 'You ask how much the assistant or research has cost.',
    example: 'How much have I spent on AI this week?',
  },
}

/**
 * The Ghostfolio MCP tools the chat may call (GHOSTFOLIO_TOOL_ALLOWLIST in
 * mcp.ts), under the names the chat sees them by. Present only when
 * Ghostfolio is connected.
 */
export const GHOSTFOLIO_CATALOG: Record<string, ToolCatalogEntry> = {
  ghostfolio_get_accounts: {
    category: 'Ghostfolio tracker',
    what: 'The accounts Ghostfolio tracks (brokers, banks, cash) with their balances.',
    useWhen: 'You ask what accounts your net worth is made of.',
    example: 'Which accounts does Ghostfolio track?',
  },
  ghostfolio_get_account_balances: {
    category: 'Ghostfolio tracker',
    what: 'The balance history of a Ghostfolio account.',
    useWhen: 'You ask how one tracked account\'s balance has changed.',
    example: 'How has my bank account balance changed?',
  },
  ghostfolio_get_portfolio_details: {
    category: 'Ghostfolio tracker',
    what: 'Your tracked portfolio broken down by holding, asset class and account.',
    useWhen: 'You ask how your whole net worth is allocated.',
    example: 'How is my net worth allocated by asset class?',
  },
  ghostfolio_get_portfolio_holdings: {
    category: 'Ghostfolio tracker',
    what: 'Every holding Ghostfolio tracks, across all accounts.',
    useWhen: 'You want holdings outside moomoo too.',
    example: 'List all my holdings in Ghostfolio',
  },
  ghostfolio_get_portfolio_performance: {
    category: 'Ghostfolio tracker',
    what: 'Ghostfolio\'s own performance figures for your tracked portfolio over a range.',
    useWhen: 'You want Ghostfolio\'s return figures rather than the app\'s snapshots.',
    example: 'What is my Ghostfolio performance year to date?',
  },
  ghostfolio_get_position: {
    category: 'Ghostfolio tracker',
    what: 'One holding as Ghostfolio records it: quantity, cost and value.',
    useWhen: 'You want to cross-check a position against the tracker.',
    example: 'What does Ghostfolio have for my NVDA position?',
  },
  ghostfolio_get_orders: {
    category: 'Ghostfolio tracker',
    what: 'The transactions recorded in Ghostfolio.',
    useWhen: 'You ask what activity the tracker has on file.',
    example: 'Show my Ghostfolio transactions this year',
  },
  ghostfolio_get_dividends: {
    category: 'Ghostfolio tracker',
    what: 'Dividends Ghostfolio has recorded.',
    useWhen: 'You ask how much dividend income you have had.',
    example: 'How much did I earn in dividends this year?',
  },
  ghostfolio_get_investments: {
    category: 'Ghostfolio tracker',
    what: 'How much you have put in over time.',
    useWhen: 'You ask how much you have invested, month by month or year by year.',
    example: 'How much did I invest each month this year?',
  },
  ghostfolio_get_benchmarks: {
    category: 'Ghostfolio tracker',
    what: 'The benchmarks Ghostfolio can compare you against.',
    useWhen: 'You want to know which indices you can compare with.',
    example: 'Which benchmarks can I compare against?',
  },
  ghostfolio_get_benchmark_performance: {
    category: 'Ghostfolio tracker',
    what: 'A benchmark\'s performance over a range.',
    useWhen: 'You want to compare your returns with an index.',
    example: 'How did the S&P 500 do this year?',
  },
}

/** /tools is answered by the chat route itself; it dispatches to no tool. */
export const TOOLS_GUIDE_COMMAND: { name: string; description: string; args: SlashArg[] } = {
  name: 'tools',
  description: 'Show every tool the assistant can use, grouped by what it is for, with example prompts.',
  args: [],
}

export const TOOLS_GUIDE_INTRO =
  'Here is everything I can use in this chat, grouped by what it is for. Open a group and click an example to put it in the composer, or just ask in your own words.'

export function isToolsGuideCommand(text: string): boolean {
  return text.trim().toLowerCase() === `/${TOOLS_GUIDE_COMMAND.name}`
}

function usageOf(cmd: { name: string; args: SlashArg[] }): string {
  return [`/${cmd.name}`, ...cmd.args.map(a => `<${a.name}>`)].join(' ')
}

function ghostfolioNote(status: GhostfolioStatus): string[] {
  if (status === 'ok') return []
  if (status === 'failing') return ['Ghostfolio is configured but not responding, so its tracker tools are unavailable right now.']
  return ['Ghostfolio tracker tools appear here once Ghostfolio is configured.']
}

export function buildToolGuide(opts: { ghostfolio: GhostfolioStatus }): ToolGuide {
  const entries = Object.entries(TOOL_CATALOG)
    .concat(opts.ghostfolio === 'ok' ? Object.entries(GHOSTFOLIO_CATALOG) : [])

  const categories: ToolGuideCategory[] = TOOL_CATEGORIES
    .map(category => ({
      category,
      blurb: CATEGORY_BLURBS[category],
      tools: entries
        .filter(([, e]) => e.category === category)
        .map(([name, e]) => ({ name, what: e.what, useWhen: e.useWhen, example: e.example, slash: [...(e.slash ?? [])] })),
    }))
    .filter(c => c.tools.length > 0)

  const commands: ToolGuideCommand[] = [TOOLS_GUIDE_COMMAND, ...SLASH_COMMANDS]
    .map(c => ({ name: c.name, usage: usageOf(c), description: c.description }))

  return { categories, commands, notes: ghostfolioNote(opts.ghostfolio) }
}
