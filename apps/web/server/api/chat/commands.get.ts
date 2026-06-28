import { defineEventHandler } from 'h3'
import { SLASH_COMMANDS } from '../../llm/research/commands'

// Static registry for the client slash-command palette. No auth-sensitive data.
export default defineEventHandler(() => ({ commands: SLASH_COMMANDS }))
