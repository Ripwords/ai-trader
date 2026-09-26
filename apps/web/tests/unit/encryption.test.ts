import { afterEach, describe, expect, it } from 'vitest'
import { pgTable } from 'drizzle-orm/pg-core'
import { decrypt, encrypt } from '../../server/utils/encryption'
import { encryptedText } from '../../db/encrypted-text'

const SECRET = 'test-secret-0123456789abcdef0123456789'

describe('encrypt / decrypt', () => {
  it('round-trips a value', () => {
    expect(decrypt(encrypt('sk-ant-abc123', SECRET), SECRET)).toBe('sk-ant-abc123')
  })

  it('salts each encryption so equal plaintexts differ', () => {
    expect(encrypt('same', SECRET)).not.toBe(encrypt('same', SECRET))
  })

  it('rejects a tampered ciphertext', () => {
    const buf = Buffer.from(encrypt('sk-ant-abc123', SECRET), 'base64')
    buf[buf.length - 1] = buf[buf.length - 1]! ^ 0xff
    expect(() => decrypt(buf.toString('base64'), SECRET)).toThrow()
  })

  it('rejects the wrong key instead of returning garbage', () => {
    expect(() => decrypt(encrypt('sk-ant-abc123', SECRET), 'another-secret')).toThrow()
  })

  it('rejects a payload too short to hold salt, iv and tag', () => {
    expect(() => decrypt(Buffer.from('short').toString('base64'), SECRET)).toThrow()
  })
})

describe('encryptedText column', () => {
  const table = pgTable('t', { secret: encryptedText('secret') })
  const prev = process.env.ENCRYPTION_KEY

  afterEach(() => {
    if (prev === undefined) delete process.env.ENCRYPTION_KEY
    else process.env.ENCRYPTION_KEY = prev
  })

  it('stores ciphertext and reads back plaintext', () => {
    process.env.ENCRYPTION_KEY = SECRET
    const stored = table.secret.mapToDriverValue('sk-live-key')
    expect(stored).not.toContain('sk-live-key')
    expect(table.secret.mapFromDriverValue(stored)).toBe('sk-live-key')
  })

  it('fails loudly when ENCRYPTION_KEY is missing', () => {
    delete process.env.ENCRYPTION_KEY
    expect(() => table.secret.mapToDriverValue('x')).toThrow(/ENCRYPTION_KEY/)
  })

  it('refuses the example key and short keys', () => {
    for (const key of ['change-me-run-openssl-rand-base64-32', 'too-short']) {
      process.env.ENCRYPTION_KEY = key
      expect(() => table.secret.mapToDriverValue('x'), key).toThrow(/ENCRYPTION_KEY/)
    }
  })

  it('names ENCRYPTION_KEY when a stored value no longer decrypts', () => {
    process.env.ENCRYPTION_KEY = SECRET
    const stored = table.secret.mapToDriverValue('sk-live-key')
    process.env.ENCRYPTION_KEY = 'rotated-secret-0123456789abcdef0123456789'
    expect(() => table.secret.mapFromDriverValue(stored)).toThrow(/ENCRYPTION_KEY/)
  })
})
