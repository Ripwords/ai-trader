import { defineNitroPlugin } from 'nitropack/runtime'
import { applyConnectAttemptTimeout } from '../utils/connect-timeout'

export default defineNitroPlugin(() => {
  applyConnectAttemptTimeout()
})
