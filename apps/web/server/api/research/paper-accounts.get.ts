import { getApiClient } from '../../llm/http'

export interface PaperAccount {
  acc_id: string
  acc_type: string
  acc_role: string | null
  markets: string[]
}

export default defineEventHandler(async (): Promise<{ accounts: PaperAccount[] }> => {
  const accounts = await getApiClient().listAccounts()
  return {
    accounts: accounts
      .filter(a => a.trd_env === 'SIMULATE' && a.acc_role !== 'IPO')
      .map(a => ({
        acc_id: a.acc_id,
        acc_type: a.acc_type,
        acc_role: a.acc_role,
        markets: a.trdmarket_auth,
      })),
  }
})
