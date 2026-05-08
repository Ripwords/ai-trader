import { getApiClient } from '../llm/http'

export default defineEventHandler(() => getApiClient().listWatchlist({}))
