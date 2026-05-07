<script setup lang="ts">
interface Position { code: string; qty: number; cost_price: number; current_price: number; market_val: number; pl_val: number; pl_ratio: number }
const props = defineProps<{ cash: number; market_val: number; total_assets: number; positions: Position[] }>()
function fmt(n: number) { return n.toLocaleString(undefined, { maximumFractionDigits: 2 }) }
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex justify-between"><span class="font-medium">Portfolio</span><span class="text-xs text-gray-500">total {{ fmt(props.total_assets) }}</span></div>
    </template>
    <div class="grid grid-cols-3 gap-2 mb-3 text-sm">
      <div><div class="text-gray-500">Cash</div><div>{{ fmt(props.cash) }}</div></div>
      <div><div class="text-gray-500">Market Value</div><div>{{ fmt(props.market_val) }}</div></div>
      <div><div class="text-gray-500">Total</div><div>{{ fmt(props.total_assets) }}</div></div>
    </div>
    <table class="w-full text-sm">
      <thead class="text-left text-xs text-gray-500"><tr><th>Code</th><th>Qty</th><th>Avg</th><th>Last</th><th>P/L</th></tr></thead>
      <tbody>
        <tr v-for="p in props.positions" :key="p.code" class="border-t border-gray-200 dark:border-gray-700">
          <td class="font-mono">{{ p.code }}</td>
          <td>{{ p.qty }}</td>
          <td>{{ fmt(p.cost_price) }}</td>
          <td>{{ fmt(p.current_price) }}</td>
          <td :class="p.pl_val >= 0 ? 'text-emerald-500' : 'text-red-500'">{{ fmt(p.pl_val) }} ({{ fmt(p.pl_ratio * 100) }}%)</td>
        </tr>
      </tbody>
    </table>
  </UCard>
</template>
