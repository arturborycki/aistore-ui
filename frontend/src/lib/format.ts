const nf = new Intl.NumberFormat(undefined)
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

export function formatNumber(n: number | undefined | null): string {
  return n == null || Number.isNaN(n) ? '—' : nf.format(n)
}

export function formatCompact(n: number | undefined | null): string {
  return n == null || Number.isNaN(n) ? '—' : compact.format(n)
}

const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB']

export function formatBytes(n: number | undefined | null): string {
  if (n == null || Number.isNaN(n)) return '—'
  let v = n
  let i = 0
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
]

export function formatRelative(d: Date | string | number | undefined | null): string {
  if (d == null) return '—'
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return '—'
  const diff = (date.getTime() - Date.now()) / 1000
  for (const [unit, secs] of steps) {
    if (Math.abs(diff) >= secs || unit === 'second') {
      return rtf.format(Math.round(diff / secs), unit)
    }
  }
  return '—'
}

const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' })

export function formatDateTime(d: Date | string | number | undefined | null): string {
  if (d == null) return '—'
  const date = d instanceof Date ? d : new Date(d)
  return Number.isNaN(date.getTime()) ? '—' : dtf.format(date)
}

/** Turns camelCase / snake-case / kebab-case keys into labels. */
export function humanize(key: string): string {
  const s = key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase()
}
