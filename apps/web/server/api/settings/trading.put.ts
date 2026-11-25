import { tradingSettingsSchema } from '../../../types/trading'
import { saveTradingSettings } from '../../lib/trading-settings'

export default defineEventHandler(async (event) => {
  const settings = await readValidatedBody(event, tradingSettingsSchema.parse)
  await saveTradingSettings(settings)
  return { settings }
})
