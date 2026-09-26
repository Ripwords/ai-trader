import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const SALT_LENGTH = 16
const IV_LENGTH = 12
const TAG_LENGTH = 16

function deriveKey(secret: string, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, salt, 'encryption', 32))
}

/** AES-256-GCM with a per-value HKDF salt. Output: base64(salt ‖ iv ‖ tag ‖ ciphertext). */
export function encrypt(value: string, secret: string): string {
  const salt = randomBytes(SALT_LENGTH)
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, deriveKey(secret, salt), iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}

export function decrypt(payload: string, secret: string): string {
  const buffer = Buffer.from(payload, 'base64')
  if (buffer.length < SALT_LENGTH + IV_LENGTH + TAG_LENGTH) {
    throw new Error('Encrypted payload is truncated')
  }
  const salt = buffer.subarray(0, SALT_LENGTH)
  const iv = buffer.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH)
  const tag = buffer.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const ciphertext = buffer.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, deriveKey(secret, salt), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}
