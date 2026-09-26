import { customType } from 'drizzle-orm/pg-core'
import { createError } from 'h3'
import { decrypt, encrypt } from '../server/utils/encryption'
import { secretProblem } from '../server/utils/secrets'

function encryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY
  const problem = secretProblem('ENCRYPTION_KEY', key)
  if (problem || !key) throw new Error(problem ?? 'ENCRYPTION_KEY is not set.')
  return key
}

/** A text column holding AES-256-GCM ciphertext; the app reads and writes plaintext. */
export const encryptedText = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'text'
  },
  toDriver(value) {
    return encrypt(value, encryptionKey())
  },
  fromDriver(value) {
    const key = encryptionKey()
    try {
      return decrypt(value, key)
    }
    catch {
      // An h3 error keeps its message in production and gives the chat page
      // and the api a code to point the user at Settings.
      throw createError({
        statusCode: 409,
        statusMessage: 'llm_key_unreadable',
        message: 'A stored API key could not be decrypted: ENCRYPTION_KEY changed since it was saved. Open Settings, edit the provider and re-enter its key.',
        data: { code: 'llm_key_unreadable' },
      })
    }
  },
})
