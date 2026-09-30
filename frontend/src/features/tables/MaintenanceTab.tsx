import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
import { MaintenanceSettings } from '@/features/settings/SettingsEditors'
import { CircleCheck, CircleDashed, CircleOff, CircleX, Wrench } from 'lucide-react'
import { Badge, type Tone } from '@/components/ui/badge'
import { Card } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { deleteTableMaintenance, getTableMaintenanceConfig, getTableMaintenanceStatus, putTableMaintenance, type MaintenanceJobStatus, type MaintenanceType } from '@/lib/catalog'
import { formatDateTime, formatRelative } from '@/lib/format'
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
    case undefined:
    case 'Not_Yet_Run':
      return { tone: 'info', label: 'Not yet run', icon: <CircleDashed className="size-3" /> }
    default:
      return { tone: 'neutral', label: s ?? 'Unknown', icon: <CircleDashed className="size-3" /> }
  }
}

export function useMaintenanceStatus(cluster: string, wh: string, ns: Namespace, table: string) {
  return useQuery({
    queryKey: [...qk.table(cluster, wh, ns, table), 'maintenance-status'],
    // AIStor answers 404 (MaintenanceConfigurationNotFound) when no job was
    // ever configured or run for the table: that is "not yet run", not an error.
    queryFn: async () => {
      try {
        return await getTableMaintenanceStatus(cluster, wh, ns, table)
      } catch (e) {
        if (e instanceof ApiError && e.isNotFound) return { status: {} }
        throw e
      }
    },
    staleTime: 60_000,
  })
}

/** Worst status across maintenance jobs, for the table header badge. */
export function MaintenanceHealthBadge({ status }: { status?: Partial<Record<MaintenanceType, MaintenanceJobStatus>> }) {
  const vals = Object.values(status ?? {}).map((s) => s?.status)
  if (vals.length === 0) return null
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

export function MaintenanceTab({ cluster, wh, ns, table }: { cluster: string; wh: string; ns: Namespace; table: string }) {
  const status = useMaintenanceStatus(cluster, wh, ns, table)
  const key = qk.table(cluster, wh, ns, table)
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">Last runs</h3>
        {status.isError ? (
          <ErrorState error={status.error} compact onRetry={() => status.refetch()} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-3">
            {MAINTENANCE.map((m) => {
              const s = status.data?.status?.[m.type]
              const meta = statusMeta(s?.status)
              return (
                <Card key={m.type} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium">{m.title}</span>
                    {status.isPending ? (
                      <Skeleton className="h-5 w-20" />
                    ) : (
                      <Badge tone={meta.tone}>
                        {meta.icon}
                        {meta.label}
                      </Badge>
                    )}
                  </div>
                  {s?.lastRunTimestamp && (
                    <Tooltip content={formatDateTime(s.lastRunTimestamp)}>
                      <span className="text-[12px] text-muted">Last run {formatRelative(s.lastRunTimestamp)}</span>
                    </Tooltip>
                  )}
                  {s?.failureMessage && <p className="mt-2 rounded-[var(--radius-control)] bg-danger-subtle px-2.5 py-1.5 font-mono text-[12px] text-danger">{s.failureMessage}</p>}
                </Card>
              )
            })}
          </div>
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-subtle">Configuration</h3>
        <MaintenanceSettings
          queryKey={[...key, 'maintenance-config']}
          types={MAINTENANCE.map((m) => m.type)}
          load={() => getTableMaintenanceConfig(cluster, wh, ns, table)}
          save={async (t, v) => {
            await putTableMaintenance(cluster, wh, ns, table, t, v)
            void status.refetch()
          }}
          reset={(t) => deleteTableMaintenance(cluster, wh, ns, table, t)}
        />
      </section>
    </div>
  )
}
