import { getPlanningSettings } from '../../lib/planning-settings'

export default defineEventHandler(async () => {
  return getPlanningSettings()
})
