import { getApiClient } from '../mastra/http'

export default defineEventHandler(() => getApiClient().listWatchlist({}))
