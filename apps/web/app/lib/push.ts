/** Browser half of Web Push: capability checks and the subscribe/unsubscribe dance. */

export function pushSupported(): boolean {
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
}

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  // iPadOS reports itself as a Mac; touch points give it away.
  return /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
}

/** Launched from the Home Screen (iOS only allows push there). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  const nav = navigator as Navigator & { standalone?: boolean }
  return window.matchMedia('(display-mode: standalone)').matches || nav.standalone === true
}

/** The VAPID public key (base64url) as the bytes pushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padded = base64Url + '='.repeat((4 - (base64Url.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/**
 * Whether a subscription was made with the server's current VAPID key. One made
 * with an older key is refused on every push, so it has to be replaced. Browsers
 * that do not report the key get the benefit of the doubt.
 */
export function subscribedWithKey(applicationServerKey: ArrayBuffer | null, publicKey: string): boolean {
  if (!applicationServerKey) return true
  const have = new Uint8Array(applicationServerKey)
  const want = urlBase64ToUint8Array(publicKey)
  return have.length === want.length && have.every((b, i) => b === want[i])
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  return navigator.serviceWorker.ready
}

/** This browser's current subscription endpoint, or null. Never prompts. */
export async function currentEndpoint(): Promise<string | null> {
  if (!pushSupported()) return null
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  return sub?.endpoint ?? null
}

/**
 * Ask permission, subscribe and register with the server. Call only from a
 * click handler: browsers ignore (and iOS rejects) a prompt without one.
 */
export async function enablePush(): Promise<{ endpoint: string }> {
  if (!pushSupported()) throw new Error('this browser does not support push notifications')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error(permission === 'denied' ? 'notifications are blocked for this site in the browser settings' : 'permission was not granted')
  const { publicKey } = await $fetch<{ publicKey: string }>('/api/push/vapid-key')
  const reg = await registration()
  let existing = await reg.pushManager.getSubscription()
  if (existing && !subscribedWithKey(existing.options.applicationServerKey, publicKey)) {
    await $fetch('/api/push/subscribe', { method: 'DELETE', body: { endpoint: existing.endpoint } }).catch(() => {})
    await existing.unsubscribe()
    existing = null
  }
  const sub = existing
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) })
  const json = sub.toJSON()
  await $fetch('/api/push/subscribe', {
    method: 'POST',
    body: { endpoint: sub.endpoint, keys: json.keys, userAgent: navigator.userAgent },
  })
  return { endpoint: sub.endpoint }
}

/** Unsubscribe this browser and drop it on the server. */
export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/')
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return
  await $fetch('/api/push/subscribe', { method: 'DELETE', body: { endpoint: sub.endpoint } }).catch(() => {})
  await sub.unsubscribe()
}
