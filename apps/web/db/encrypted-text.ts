import { customType } from 'drizzle-orm/pg-core'
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
      throw new Error('A stored secret could not be decrypted. ENCRYPTION_KEY changed since it was saved; re-enter the key in Settings.')
    }
  },
})
