import { getHeartbeat } from '../../lib/scheduler'

export default defineEventHandler(async () => ({
  heartbeat: await getHeartbeat(),
  // The client measures "Xs ago" against server time, not its own clock.
  now: new Date().toISOString(),
}))
