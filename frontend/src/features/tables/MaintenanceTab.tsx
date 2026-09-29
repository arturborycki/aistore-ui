import { useQuery } from '@tanstack/react-query'
import { CircleCheck, CircleDashed, CircleOff, CircleX, Wrench } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/badge'
import { Card, CardHeader, KeyValue } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { getTableMaintenanceConfig, getTableMaintenanceStatus, type MaintenanceJobStatus, type MaintenanceType } from '@/lib/catalog'
import { formatDateTime, formatRelative, humanize } from '@/lib/format'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'

export const MAINTENANCE: { type: MaintenanceType; title: string; description: string }[] = [
  { type: 'icebergCompaction', title: 'Compaction', description: 'Rewrites small data files into larger ones for faster scans.' },
  { type: 'icebergSnapshotManagement', title: 'Snapshot expiration', description: 'Expires old snapshots according to retention settings.' },
  { type: 'icebergUnreferencedFileRemoval', title: 'Unreferenced file removal', description: 'Deletes files no longer referenced by any snapshot.' },
]

export function statusMeta(s?: string): { tone: Tone; label: string; icon: React.ReactNode } {
  switch (s) {
    case 'Successful':
      return { tone: 'success', label: 'Healthy', icon: <CircleCheck className="size-3" /> }
    case 'Failed':
      return { tone: 'danger', label: 'Failed', icon: <CircleX className="size-3" /> }
    case 'Disabled':
      return { tone: 'neutral', label: 'Disabled', icon: <CircleOff className="size-3" /> }
    case 'Not_Yet_Run':
      return { tone: 'info', label: 'Not yet run', icon: <CircleDashed className="size-3" /> }
    default:
      return { tone: 'neutral', label: s ?? 'Unknown', icon: <CircleDashed className="size-3" /> }
  }
}

export function useMaintenanceStatus(cluster: string, wh: string, ns: Namespace, table: string) {
  return useQuery({
    queryKey: [...qk.table(cluster, wh, ns, table), 'maintenance-status'],
    queryFn: () => getTableMaintenanceStatus(cluster, wh, ns, table),
    staleTime: 60_000,
  })
}

/** Worst status across maintenance jobs, for the table header badge. */
export function MaintenanceHealthBadge({ status }: { status?: Partial<Record<MaintenanceType, MaintenanceJobStatus>> }) {
  if (!status) return null
  const vals = Object.values(status).map((s) => s?.status)
  const worst = vals.includes('Failed') ? 'Failed' : vals.every((v) => v === 'Disabled') ? 'Disabled' : vals.includes('Successful') ? 'Successful' : 'Not_Yet_Run'
  const m = statusMeta(worst)
  return (
    <Tooltip content="Automated maintenance (worst status across jobs)">
      <span>
        <Badge tone={m.tone}>
          <Wrench className="size-3" /> {worst === 'Successful' ? 'Maintained' : `Maintenance: ${m.label.toLowerCase()}`}
        </Badge>
      </span>
    </Tooltip>
  )
}

function flattenSettings(v: unknown, prefix = ''): { label: string; value: string }[] {
  if (v == null || typeof v !== 'object') return [{ label: prefix || 'value', value: String(v) }]
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) =>
    x != null && typeof x === 'object' ? flattenSettings(x, prefix ? `${prefix} · ${humanize(k)}` : humanize(k)) : [{ label: prefix ? `${prefix} · ${humanize(k)}` : humanize(k), value: String(x) }],
  )
}

export function MaintenanceTab({ cluster, wh, ns, table }: { cluster: string; wh: string; ns: Namespace; table: string }) {
  const status = useMaintenanceStatus(cluster, wh, ns, table)
  const config = useQuery({ queryKey: [...qk.table(cluster, wh, ns, table), 'maintenance-config'], queryFn: () => getTableMaintenanceConfig(cluster, wh, ns, table) })
  const cfg = (config.data?.configuration ?? config.data ?? {}) as Record<string, { status?: string; settings?: Record<string, unknown> } | undefined>

  if (status.isError) return <ErrorState error={status.error} onRetry={() => status.refetch()} />
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {MAINTENANCE.map((m) => {
        const s = status.data?.status?.[m.type]
        const meta = statusMeta(s?.status)
        const c = cfg[m.type]
        const settings = c?.settings ? flattenSettings((c.settings as Record<string, unknown>)[m.type] ?? c.settings) : []
        return (
          <Card key={m.type}>
            <CardHeader title={m.title} description={m.description} />
            <div className="flex flex-col gap-3 p-4">
              {status.isPending ? (
                <Skeleton className="h-16" />
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <Badge tone={meta.tone}>
                      {meta.icon}
                      {meta.label}
                    </Badge>
                    {s?.lastRunTimestamp && (
                      <Tooltip content={formatDateTime(s.lastRunTimestamp)}>
                        <span className="text-[12px] text-muted">Last run {formatRelative(s.lastRunTimestamp)}</span>
                      </Tooltip>
                    )}
                  </div>
                  {s?.failureMessage && <p className="rounded-[var(--radius-control)] bg-danger-subtle px-2.5 py-1.5 font-mono text-[12px] text-danger">{s.failureMessage}</p>}
                  {!s && <p className="text-[12.5px] text-subtle">Not configured for this table.</p>}
                </>
              )}
              <div className="border-t border-border pt-3">
                <div className="mb-2 text-[11px] font-medium uppercase tracking-wide text-subtle">Configuration</div>
                {config.isPending ? (
                  <Skeleton className="h-10" />
                ) : config.isError ? (
                  <ErrorState error={config.error} compact />
                ) : c ? (
                  <KeyValue items={[{ label: 'Status', value: c.status ?? '—' }, ...settings.map((x) => ({ label: x.label, value: <span className="font-mono text-[12px]">{x.value}</span> }))]} />
                ) : (
                  <p className="text-[12.5px] text-subtle">Inherits the warehouse defaults.</p>
                )}
              </div>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
