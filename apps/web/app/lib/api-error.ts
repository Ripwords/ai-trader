function field(obj: object, key: string): unknown {
  return (obj as Record<string, unknown>)[key]
}

export function apiErrorMessage(e: unknown, fallback: string): string {
  if (typeof e !== 'object' || e === null) return fallback
  const data = field(e, 'data')
  if (typeof data === 'object' && data !== null) {
    const detail = field(data, 'detail')
    if (typeof detail === 'string' && detail) return detail
  }
  const statusMessage = field(e, 'statusMessage')
  if (typeof statusMessage === 'string' && statusMessage) return statusMessage
  const message = field(e, 'message')
  if (typeof message === 'string' && message) return message
  return fallback
}
