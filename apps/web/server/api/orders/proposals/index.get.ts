import { listProposals } from '../../../lib/order-proposals'

/** Pending proposals and the last week's decided ones; stale pending ones expire on read. */
export default defineEventHandler(() => listProposals())
