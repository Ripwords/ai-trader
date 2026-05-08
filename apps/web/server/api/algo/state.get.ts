import { getAlgoApi } from '../../llm/http'

export default defineEventHandler(() => getAlgoApi().state())
