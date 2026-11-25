import { getTradingSettings } from '../../lib/trading-settings'

export default defineEventHandler(async () => ({ settings: await getTradingSettings() }))
