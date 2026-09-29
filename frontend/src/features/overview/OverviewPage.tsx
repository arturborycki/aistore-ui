import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { Activity, Database, FolderTree, HardDrive, Rows3, Table2, Warehouse } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Tooltip } from '@/components/ui/tooltip'
import { getGlobalStats, listWarehouses } from '@/lib/catalog'
import { formatBytes, formatCompact, formatNumber, formatRelative, humanize } from '@/lib/format'
import { listActivity } from '@/lib/session'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { OutcomeBadge } from '@/features/activity/ActivityPage'

const ICONS: Record<string, React.ReactNode> = {
  warehouses: <Warehouse />,
  namespaces: <FolderTree />,
  tables: <Table2 />,
  records: <Rows3 />,
  size: <HardDrive />,
}

const isSizeKey = (k: string) => /size|bytes/i.test(k)

/** Flattens the stats document into numeric tiles (the server owns the shape). */
function numericEntries(doc: Record<string, unknown> | undefined): [string, number][] {
  if (!doc) return []
  const out: [string, number][] = []
  for (const [k, v] of Object.entries(doc)) {
    if (typeof v === 'number') out.push([k, v])
    else if (v && typeof v === 'object' && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Record<string, unknown>)) if (typeof v2 === 'number') out.push([k2, v2])
    }
  }
  const order = ['warehouses', 'namespaces', 'tables', 'views', 'records', 'size']
  return out.sort(([a], [b]) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)).slice(0, 8)
}

function GlobalStats({ cluster }: { cluster: string }) {
  const q = useQuery({ queryKey: qk.globalStats(cluster), queryFn: () => getGlobalStats(cluster), staleTime: 60_000 })
  if (q.isError) return <ErrorState error={q.error} compact onRetry={() => q.refetch()} />
  const entries = numericEntries(q.data)
  if (q.isPending)
    return (
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <StatCard key={i} label="…" value="" loading />
        ))}
      </div>
    )
  if (entries.length === 0) return null
  const cols = entries.length % 5 === 0 ? 'xl:grid-cols-5' : entries.length % 3 === 0 ? 'xl:grid-cols-3' : 'xl:grid-cols-4'
  return (
    <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${cols}`}>
      {entries.map(([k, v]) => (
        <StatCard key={k} label={humanize(k)} icon={ICONS[k] ?? <Database />} value={isSizeKey(k) ? formatBytes(v) : <span title={formatNumber(v)}>{formatCompact(v)}</span>} />
      ))}
    </div>
  )
}

/** Single-series magnitude: one hue, thin bars, values in text colours. */
function LargestWarehouses({ cluster }: { cluster: string }) {
  const navigate = useNavigate()
  const q = useQuery({
    queryKey: [...qk.warehouses(cluster), 'largest'],
    queryFn: () => listWarehouses(cluster, { sort: 'size', sortOrder: 'desc', pageSize: 8 }),
    staleTime: 60_000,
  })
  const rows = (q.data?.items ?? []).map((name) => ({ name, s: q.data!.stats[name] }))
  const max = Math.max(1, ...rows.map((r) => r.s?.size ?? 0))
  return (
    <Card>
      <CardHeader
        title="Largest warehouses"
        description="By stored size"
        actions={
          <Link to={paths.warehouses(cluster)} className="text-[12px] text-accent-text hover:underline">
            View all
          </Link>
        }
      />
      <div className="p-2">
        {q.isPending && (
          <div className="flex flex-col gap-3 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" />
            ))}
          </div>
        )}
        {q.isError && <ErrorState error={q.error} compact className="m-2" onRetry={() => q.refetch()} />}
        {q.isSuccess && rows.length === 0 && <p className="p-4 text-center text-[12.5px] text-subtle">No warehouses you can access.</p>}
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.name}>
              <Tooltip
                content={
                  <span className="tabular">
                    {r.name}: {formatBytes(r.s?.size)} · {formatNumber(r.s?.tables)} tables · {formatNumber(r.s?.records)} records
                  </span>
                }
                side="left"
              >
                <button
                  onClick={() => navigate(paths.warehouse(cluster, r.name))}
                  className="grid w-full grid-cols-[minmax(0,160px)_1fr_80px] items-center gap-3 rounded-[var(--radius-control)] px-2 py-2 text-left hover:bg-bg-subtle"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <EntityIcon kind="warehouse" />
                    <span className="truncate font-mono text-[12.5px]">{r.name}</span>
                  </span>
                  <span className="h-2 overflow-hidden rounded-full bg-surface" aria-hidden>
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(2, ((r.s?.size ?? 0) / max) * 100)}%` }} />
                  </span>
                  <span className="text-right text-[12.5px] tabular text-muted">{formatBytes(r.s?.size)}</span>
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

function RecentActivity({ cluster }: { cluster: string }) {
  const q = useQuery({ queryKey: qk.activity('me'), queryFn: () => listActivity('me', 50) })
  const rows = (q.data ?? []).filter((r) => r.kind === 'catalog').slice(0, 8)
  return (
    <Card>
      <CardHeader
        title="Your recent changes"
        actions={
          <Link to={paths.activity(cluster)} className="text-[12px] text-accent-text hover:underline">
            All activity
          </Link>
        }
      />
      <div className="p-2">
        {q.isPending && <Skeleton className="m-2 h-24" />}
        {q.isError && <ErrorState error={q.error} compact className="m-2" />}
        {q.isSuccess && rows.length === 0 && (
          <p className="flex flex-col items-center gap-1 p-6 text-center text-[12.5px] text-subtle">
            <Activity className="size-5" />
            Changes you make are recorded here.
          </p>
        )}
        <ul className="flex flex-col">
          {rows.map((r) => (
            <li key={r.requestId + r.time} className="flex items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5">
              <OutcomeBadge outcome={r.outcome} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{humanize(r.operation)}</span>
                <span className="block truncate font-mono text-[11.5px] text-muted">{r.resource}</span>
              </span>
              <span className="shrink-0 text-[11.5px] text-subtle">{formatRelative(r.time)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  )
}

export function OverviewPage() {
  const cluster = useCluster()
  const me = useMe()
  const info = me.clusters.find((c) => c.id === cluster)
  const firstName = (me.user.name || me.user.username).split(/[\s@]/)[0]
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Welcome, {firstName}</h1>
          <p className="mt-0.5 text-[12.5px] text-muted">
            {info?.name ?? cluster} · everything here reflects your own AIStor permissions.
          </p>
        </div>
        {info && !info.available && <Badge tone="warning" dot>{info.error ?? 'Cluster unavailable'}</Badge>}
      </div>
      <GlobalStats cluster={cluster} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <LargestWarehouses cluster={cluster} />
        <RecentActivity cluster={cluster} />
      </div>
    </div>
  )
}
