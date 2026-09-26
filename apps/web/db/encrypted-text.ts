import { customType } from 'drizzle-orm/pg-core'
import { decrypt, encrypt } from '../server/utils/encryption'

function encryptionKey(): string {
  const key = process.env.ENCRYPTION_KEY
  if (!key) {
    throw new Error('ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and add it to .env.')
  }
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
