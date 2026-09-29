import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleX, LockKeyhole, RefreshCw, Search } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative, humanize } from '@/lib/format'
import { listActivity, type AuditRecord } from '@/lib/session'
import { qk } from '@/lib/queryKeys'

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

export function ActivityPage() {
  const me = useMe()
  const [scope, setScope] = useState<'me' | 'all'>('me')
  const [outcome, setOutcome] = useState<(typeof OUTCOMES)[number]>('all')
  const [filter, setFilter] = useState('')
  const q = useQuery({ queryKey: qk.activity(scope), queryFn: () => listActivity(scope, 500), refetchInterval: 30_000 })

  const rows = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return (q.data ?? []).filter(
      (r) =>
        (outcome === 'all' || r.outcome === outcome) &&
        (!f || [r.operation, r.resource, r.actor.username, r.action, r.error ?? ''].some((s) => s?.toLowerCase().includes(f))),
    )
  }, [q.data, outcome, filter])

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
          <Button variant="outline" onClick={() => q.refetch()}>
            <RefreshCw className={cn(q.isFetching && 'animate-spin')} />
            Refresh
          </Button>
        }
      />
      <div className="flex flex-wrap items-center gap-2">
        {me.user.admin && (
          <div className="grid grid-cols-2 gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="tablist" aria-label="Scope">
            {(['me', 'all'] as const).map((s) => (
              <button key={s} role="tab" aria-selected={scope === s} onClick={() => setScope(s)} className={cn('h-7 rounded-[4px] px-3 text-muted', scope === s && 'bg-bg font-medium text-fg shadow-sm')}>
                {s === 'me' ? 'Mine' : 'Everyone'}
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="tablist" aria-label="Outcome">
          {OUTCOMES.map((o) => (
            <button key={o} role="tab" aria-selected={outcome === o} onClick={() => setOutcome(o)} className={cn('h-7 rounded-[4px] px-3 capitalize text-muted', outcome === o && 'bg-bg font-medium text-fg shadow-sm')}>
              {o === 'failure' ? 'Failed' : o}
            </button>
          ))}
        </div>
        <div className="relative ml-auto w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by operation, resource, user…" aria-label="Filter activity" className="pl-8" />
        </div>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => `${r.requestId}-${r.time}-${r.operation}`}
          loading={q.isPending}
          empty={<EmptyState title="No activity" className="m-3 border-0">{filter || outcome !== 'all' ? 'Nothing matches the current filters.' : 'Nothing has been recorded yet.'}</EmptyState>}
        />
      )}
    </div>
  )
}
