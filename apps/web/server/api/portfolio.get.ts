import { getFullPortfolio, type FullPortfolio } from '../lib/holdings'

export default defineEventHandler(async (): Promise<FullPortfolio> => {
  return getFullPortfolio()
})
