import { defineEventHandler } from 'h3'
import { SLASH_COMMANDS } from '../../llm/research/commands'
import { TOOLS_GUIDE_COMMAND } from '../../llm/tool-catalog'

// Static registry for the client slash-command palette. No auth-sensitive data.
// /tools comes first: the chat route answers it itself with the tool guide.
export default defineEventHandler(() => ({ commands: [TOOLS_GUIDE_COMMAND, ...SLASH_COMMANDS] }))
