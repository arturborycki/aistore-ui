import { useQuery } from '@tanstack/react-query'
import { Lock, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader, KeyValue } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { ApiError } from '@/lib/api'
import { getTableEncryption, getTableTags } from '@/lib/catalog'
import { humanize } from '@/lib/format'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'

function flat(v: unknown, prefix = ''): { label: string; value: string }[] {
  if (v == null || typeof v !== 'object') return [{ label: prefix || 'Value', value: String(v) }]
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (x != null && typeof x === 'object' ? flat(x, humanize(k)) : [{ label: humanize(k), value: String(x) }]))
}

const notConfigured = (e: unknown) => e instanceof ApiError && e.isNotFound

/** Server-side encryption and resource tags (AIStor extension endpoints). */
export function SettingsTab({ cluster, wh, ns, table }: { cluster: string; wh: string; ns: Namespace; table: string }) {
  const enc = useQuery({ queryKey: [...qk.table(cluster, wh, ns, table), 'encryption'], queryFn: () => getTableEncryption(cluster, wh, ns, table) })
  const tags = useQuery({ queryKey: [...qk.table(cluster, wh, ns, table), 'tags'], queryFn: () => getTableTags(cluster, wh, ns, table) })
  const encCfg = (enc.data?.encryptionConfiguration ?? enc.data) as Record<string, unknown> | undefined
  const tagMap = ((tags.data?.tags ?? tags.data) ?? {}) as Record<string, unknown>

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Lock className="size-4 text-muted" />Encryption</span>} description="Server-side encryption applied to this table's files." />
        <div className="p-4">
          {enc.isPending ? (
            <Skeleton className="h-12" />
          ) : enc.isError ? (
            notConfigured(enc.error) ? <p className="text-[12.5px] text-subtle">No table-level encryption; the warehouse default applies.</p> : <ErrorState error={enc.error} compact />
          ) : (
            <KeyValue
              items={flat(encCfg).map((x) => ({
                label: x.label,
                value: x.label.toLowerCase().includes('algorithm') ? <Badge tone="success"><Lock className="size-3" />{x.value}</Badge> : <span className="break-all font-mono text-[12px]">{x.value}</span>,
              }))}
            />
          )}
        </div>
      </Card>
      <Card>
        <CardHeader title={<span className="flex items-center gap-2"><Tag className="size-4 text-muted" />Tags</span>} description="Resource tags for cost allocation and governance." />
        <div className="p-4">
          {tags.isPending ? (
            <Skeleton className="h-12" />
          ) : tags.isError ? (
            notConfigured(tags.error) ? <p className="text-[12.5px] text-subtle">No tags.</p> : <ErrorState error={tags.error} compact />
          ) : Object.keys(tagMap).length === 0 ? (
            <p className="text-[12.5px] text-subtle">No tags.</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(tagMap)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([k, v]) => (
                  <span key={k} className="inline-flex h-6 items-center overflow-hidden rounded-full border border-border text-[12px]">
                    <span className="bg-surface px-2 font-mono text-muted">{k}</span>
                    <span className="px-2 font-mono">{String(v)}</span>
                  </span>
                ))}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
