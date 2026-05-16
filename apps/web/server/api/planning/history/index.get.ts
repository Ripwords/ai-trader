import { getPlanningHistory } from '../../../lib/planning-settings'

export default defineEventHandler(async () => {
  return getPlanningHistory()
})
