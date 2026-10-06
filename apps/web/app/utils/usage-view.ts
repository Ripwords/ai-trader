const CENTS = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/** Dollars to the cent; below a cent, two significant digits so a $0.0004 call doesn't read as free. */
export function formatUsdCost(n: number | null): string {
  if (n === null) return 'unpriced'
  if (n === 0 || n >= 0.01) return CENTS.format(n)
  const decimals = 1 - Math.floor(Math.log10(n))
  const rounded = Number(n.toFixed(decimals))
  if (rounded >= 0.01) return CENTS.format(rounded)
  return `$${rounded.toFixed(decimals).replace(/0+$/, '')}`
}
