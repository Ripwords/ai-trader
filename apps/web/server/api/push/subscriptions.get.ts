import { listPushDevices } from '../../lib/push/subscriptions'

export default defineEventHandler(async () => ({ devices: await listPushDevices() }))
