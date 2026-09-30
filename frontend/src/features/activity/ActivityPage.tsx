import { useEffect, useMemo, useState } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, Download, LockKeyhole, RefreshCw, Search } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { formatDateTime, formatNumber, formatRelative, humanize } from '@/lib/format'
import { activityCsv, listActivity, listAllActivity, type ActivityFilter, type AuditRecord } from '@/lib/session'
import { qk } from '@/lib/queryKeys'
import { useToast } from '@/components/ui/toast'

export function OutcomeBadge({ outcome }: { outcome: AuditRecord['outcome'] }) {
  if (outcome === 'success')
    return (
      <Badge tone="success">
        <CircleCheck className="size-3" /> Success
      </Badge>
    )
  if (outcome === 'denied')
    return (
      <Badge tone="warning">
        <LockKeyhole className="size-3" /> Denied
      </Badge>
    )
  return (
    <Badge tone="danger">
      <CircleX className="size-3" /> Failed
    </Badge>
  )
}

const OUTCOMES = ['all', 'success', 'denied', 'failure'] as const
const KINDS = ['all', 'catalog', 'auth'] as const
const RANGES = [
  { id: 'all', label: 'Any time', ms: 0 },
  { id: '1h', label: 'Last hour', ms: 3_600_000 },
  { id: '24h', label: 'Last 24 hours', ms: 86_400_000 },
  { id: '7d', label: 'Last 7 days', ms: 7 * 86_400_000 },
] as const
const PAGE = 100

/** Segmented control built from toggle buttons. */
function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly { id: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" aria-pressed={value === o.id} onClick={() => onChange(o.id)} className={cn('h-7 rounded-[4px] px-3 text-muted', value === o.id && 'bg-bg font-medium text-fg shadow-sm')}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

function useDebounced<T>(value: T, ms: number) {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms)
    return () => window.clearTimeout(t)
  }, [value, ms])
  return v
}

export function ActivityPage() {
  const me = useMe()
  const toast = useToast()
  const [scope, setScope] = useState<'me' | 'all'>('me')
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>('all')
  const [kind, setKind] = useState<(typeof KINDS)[number]>('all')
  const [range, setRange] = useState<(typeof RANGES)[number]['id']>('all')
  // "since" is fixed when the range is picked so pages stay consistent.
  const [since, setSince] = useState<string | undefined>()
  const pickRange = (id: typeof range) => {
    const ms = RANGES.find((r) => r.id === id)!.ms
    setRange(id)
    setSince(ms ? new Date(Date.now() - ms).toISOString() : undefined)
  }
  const [text, setText] = useState('')
  const q = useDebounced(text.trim(), 300)
  const [exporting, setExporting] = useState(false)

  const filter = useMemo<ActivityFilter>(
    () => ({ scope, outcome: outcome === 'all' ? undefined : outcome, kind: kind === 'all' ? undefined : kind, q: q || undefined, since }),
    [scope, outcome, kind, q, since],
  )

  const list = useInfiniteQuery({
    queryKey: [...qk.activity(scope), filter],
    queryFn: ({ pageParam }) => listActivity(filter, pageParam, PAGE),
    initialPageParam: 0,
    getNextPageParam: (last) => (last.offset + last.records.length < last.total ? last.offset + last.records.length : undefined),
    refetchInterval: 30_000,
  })
  const rows = useMemo(() => list.data?.pages.flatMap((p) => p.records) ?? [], [list.data])
  const first = list.data?.pages[0]
  const filtered = outcome !== 'all' || kind !== 'all' || range !== 'all' || q !== ''

  const exportCsv = async () => {
    setExporting(true)
    try {
      const all = await listAllActivity(filter)
      const url = URL.createObjectURL(new Blob([activityCsv(all)], { type: 'text/csv;charset=utf-8' }))
      const a = document.createElement('a')
      a.href = url
      a.download = `activity-${scope}-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`
      a.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast.success(`Exported ${all.length} record${all.length === 1 ? '' : 's'}`)
    } catch (e) {
      toast.error('Export failed', e instanceof Error ? e.message : undefined)
    } finally {
      setExporting(false)
    }
  }

  const columns: Column<AuditRecord>[] = [
    { key: 'time', header: 'When', width: '130px', cell: (r) => <Tooltip content={formatDateTime(r.time)}><span className="text-muted">{formatRelative(r.time)}</span></Tooltip> },
    ...(scope === 'all' ? [{ key: 'actor', header: 'User', cell: (r: AuditRecord) => <span className="font-medium">{r.actor.username || '—'}</span> }] : []),
    {
      key: 'op',
      header: 'Operation',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-medium">{humanize(r.operation)}</span>
          {r.action && <span className="font-mono text-[11px] text-subtle">{r.action}</span>}
        </span>
      ),
    },
    {
      key: 'resource',
      header: 'Resource',
      cell: (r) => (
        <span className="flex flex-col">
          <span className="font-mono text-[12px]">{r.resource || '—'}</span>
          {r.params && Object.keys(r.params).length > 0 && (
            <span className="font-mono text-[11px] text-subtle">{Object.entries(r.params).map(([k, v]) => `${k}=${v}`).join(' ')}</span>
          )}
        </span>
      ),
    },
    {
      key: 'outcome',
      header: 'Outcome',
      cell: (r) => (
        <span className="flex flex-col items-start gap-0.5">
          <OutcomeBadge outcome={r.outcome} />
          {r.error && <span className="max-w-[280px] truncate text-[11px] text-muted" title={r.error}>{r.error}</span>}
        </span>
      ),
    },
    { key: 'kind', header: 'Source', cell: (r) => <Badge>{r.kind === 'auth' ? 'Sign-in' : 'Catalog'}</Badge> },
  ]

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Activity"
        subtitle="Changes and sign-ins recorded by the catalog UI. Every catalog change is also in AIStor's own audit log under your identity."
        actions={
          <>
            <Button variant="outline" onClick={exportCsv} loading={exporting} disabled={!first?.total}>
              <Download />
              Export CSV
            </Button>
            <Button variant="outline" onClick={() => list.refetch()}>
              <RefreshCw className={cn(list.isFetching && !list.isFetchingNextPage && 'animate-spin')} />
              Refresh
            </Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {me.user.admin && (
          <Segmented label="Scope" value={scope} onChange={setScope} options={[{ id: 'me', label: 'Mine' }, { id: 'all', label: 'Everyone' }]} />
        )}
        <Segmented label="Outcome" value={outcome} onChange={setOutcome} options={OUTCOMES.map((o) => ({ id: o, label: o === 'failure' ? 'Failed' : o === 'all' ? 'All' : o[0].toUpperCase() + o.slice(1) }))} />
        <Segmented label="Source" value={kind} onChange={setKind} options={KINDS.map((k) => ({ id: k, label: k === 'all' ? 'All sources' : k === 'auth' ? 'Sign-in' : 'Catalog' }))} />
        <select
          aria-label="Time range"
          value={range}
          onChange={(e) => pickRange(e.target.value as typeof range)}
          className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 text-[12.5px]"
        >
          {RANGES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <div className="relative w-full sm:ml-auto sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={200} placeholder="Filter by operation, resource, user, IP…" aria-label="Filter activity" className="pl-8" />
        </div>
      </div>
      {list.isError ? (
        <ErrorState error={list.error} onRetry={() => list.refetch()} />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => `${r.requestId}-${r.time}-${r.operation}`}
            loading={list.isPending}
            empty={<EmptyState title="No activity" className="m-3 border-0">{filtered ? 'Nothing matches the current filters.' : 'Nothing has been recorded yet.'}</EmptyState>}
          />
          {first && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted">
              <span aria-live="polite">
                Showing {formatNumber(rows.length)} of {formatNumber(first.total)} {filtered ? 'matching ' : ''}records · the most recent {formatNumber(first.retained)} are kept
              </span>
              {list.hasNextPage && (
                <Button variant="outline" size="sm" onClick={() => list.fetchNextPage()} loading={list.isFetchingNextPage}>
                  Load more
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
