import { savePlanningSettings } from '../../lib/planning-settings'

export default defineEventHandler(async (event) => {
  const body = await readBody(event)
  return savePlanningSettings(body)
})
