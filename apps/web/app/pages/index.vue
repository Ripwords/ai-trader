<script setup lang="ts">
import { ref } from 'vue'
import ChartCard from '~/components/chart/ChartCard.vue'

interface KLineResult {
  code: string
  ktype: string
  bars: { time: string; open: number; high: number; low: number; close: number; volume: number; turnover: number }[]
}

interface Msg {
  id: string
  role: 'user' | 'assistant'
  content: string
  toolResult?: KLineResult
  error?: string
}

const messages = ref<Msg[]>([])
const input = ref('')
const busy = ref(false)

async function send() {
  const text = input.value.trim()
  if (!text || busy.value) return
  input.value = ''
  const userMsg: Msg = { id: crypto.randomUUID(), role: 'user', content: text }
  messages.value.push(userMsg)
  const asst: Msg = { id: crypto.randomUUID(), role: 'assistant', content: '' }
  messages.value.push(asst)
  busy.value = true
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: messages.value
          .filter((m) => m.role === 'user' || (m.role === 'assistant' && m.content))
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    })
    if (!res.body) throw new Error('no body')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        let chunk: { type: string; payload?: any } | null = null
        try {
          chunk = JSON.parse(line)
        } catch {
          continue
        }
        if (!chunk) continue
        if (chunk.type === 'text-delta') {
          asst.content += chunk.payload?.text ?? ''
        } else if (chunk.type === 'tool-call') {
          asst.content += `\n_calling ${chunk.payload?.toolName ?? 'tool'}…_\n`
        } else if (chunk.type === 'tool-result') {
          const result = chunk.payload?.result
          if (result?.bars && Array.isArray(result.bars)) {
            asst.toolResult = result as KLineResult
          }
        } else if (chunk.type === 'error') {
          asst.error = chunk.payload?.message ?? 'unknown error'
        }
      }
    }
  } catch (e: unknown) {
    asst.error = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function logout() {
  await $fetch('/api/logout', { method: 'POST' })
  await navigateTo('/login')
}
</script>

<template>
  <div class="h-screen flex flex-col">
    <header class="px-4 py-2 border-b flex items-center justify-between">
      <h1 class="font-semibold">ai-trader</h1>
      <UButton size="xs" variant="ghost" @click="logout">Sign out</UButton>
    </header>
    <main class="flex-1 overflow-y-auto px-4 py-3 space-y-4">
      <div v-for="m in messages" :key="m.id" class="space-y-2">
        <div class="text-xs text-gray-400 uppercase tracking-wide">{{ m.role === 'user' ? 'You' : 'Copilot' }}</div>
        <div class="whitespace-pre-wrap" v-if="m.content">{{ m.content }}</div>
        <ChartCard v-if="m.toolResult" :code="m.toolResult.code" :ktype="m.toolResult.ktype" :bars="m.toolResult.bars" />
        <div v-if="m.error" class="text-sm text-red-500">{{ m.error }}</div>
      </div>
    </main>
    <footer class="border-t p-2">
      <form class="flex gap-2" @submit.prevent="send">
        <UInput v-model="input" class="flex-1" placeholder="Show me NVDA daily" :disabled="busy" />
        <UButton type="submit" :loading="busy">Send</UButton>
      </form>
    </footer>
  </div>
</template>
