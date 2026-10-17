import { createReminder } from '../../lib/reminders'
import { dueAtProblem, reminderCreateSchema } from '../../lib/reminders-core'

export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, reminderCreateSchema.parse)
  const dueAt = new Date(body.dueAt)
  const problem = dueAtProblem(dueAt, new Date())
  if (problem) throw createError({ statusCode: 400, statusMessage: problem })
  const reminder = await createReminder({ dueAt, message: body.message, symbol: body.symbol?.trim().toUpperCase() || null })
  return { reminder }
})
