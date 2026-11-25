import { z } from 'zod'

// Settings → Trading. Debate proposals: after a debate rates a stock buy or
// sell, put a matching order in the approval queue on the Orders page.

export const tradingSettingsSchema = z.object({
  debateProposals: z.boolean(),
  /** The account proposals target. Null: the paper account for each stock's market. */
  accId: z.string().min(1).nullable(),
  trdEnv: z.enum(['SIMULATE', 'REAL']),
  /** Money per buy proposal, in the stock's own currency. */
  notional: z.number().positive().max(10_000_000),
}).refine(s => s.trdEnv === 'SIMULATE' || s.accId !== null, { message: 'a live target needs an account', path: ['accId'] })

export type TradingSettings = z.infer<typeof tradingSettingsSchema>

export const DEFAULT_TRADING_SETTINGS: TradingSettings = {
  debateProposals: false,
  accId: null,
  trdEnv: 'SIMULATE',
  notional: 1000,
}
