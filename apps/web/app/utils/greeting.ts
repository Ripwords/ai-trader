export type DayPart = 'morning' | 'afternoon' | 'evening'

export function dayPart(hour: number): DayPart {
  if (hour < 12) return 'morning'
  if (hour < 18) return 'afternoon'
  return 'evening'
}
