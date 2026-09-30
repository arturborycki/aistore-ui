import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { KeyRound, Layers } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { TypeChip } from '@/components/ui/type-chip'
import { loadTable } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import { currentSchema, flattenSchema } from '@/lib/iceberg'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'

/** A table's columns shown inline (e.g. under a row of a table list). */
export function InlineColumns({ cluster, wh, ns, table }: { cluster: string; wh: string; ns: Namespace; table: string }) {
  const q = useQuery({ queryKey: qk.table(cluster, wh, ns, table), queryFn: () => loadTable(cluster, wh, ns, table), staleTime: 60_000 })
  if (q.isPending) return <Skeleton className="h-16" />
  if (q.isError) return <ErrorState error={q.error} compact />
  const md = q.data.metadata
  const schema = currentSchema(md)
  if (!schema) return null
  const idents = new Set(schema['identifier-field-ids'] ?? [])
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const parts = new Set(spec?.fields.map((f) => f['source-id']) ?? [])
  const cols = flattenSchema(schema).filter((f) => !f.role)
  const base = paths.table(cluster, wh, ns, table, 'schema')
  return (
    <div className="overflow-x-auto rounded-[var(--radius-control)] border border-border bg-bg">
      <table className="w-full text-[12.5px]" aria-label={`Columns of ${table}`}>
        <thead>
          <tr className="border-b border-border text-left text-[11px] text-muted">
            <th className="h-7 w-12 px-2 text-right font-medium">ID</th>
            <th className="px-2 font-medium">Column</th>
            <th className="px-2 font-medium">Type</th>
            <th className="px-2 font-medium">Nullability</th>
            <th className="px-2 font-medium">Description</th>
          </tr>
        </thead>
        <tbody>
          {cols.map((f) => (
            <tr key={f.id} className="border-b border-border last:border-0">
              <td className="h-7 px-2 text-right font-mono text-[11px] text-subtle">{f.id}</td>
              <td className="px-2">
                <span className="flex items-center gap-1" style={{ paddingLeft: f.depth * 14 }}>
                  <Link to={`${base}&col=${f.id}`} className={cn('font-mono hover:text-accent-text hover:underline', f.required && 'font-semibold')}>
                    {f.name}
                  </Link>
                  {idents.has(f.id) && <KeyRound className="size-3 text-warning" aria-label="Row key" />}
                  {parts.has(f.id) && <Layers className="size-3 text-ent-namespace" aria-label="Partition source" />}
                </span>
              </td>
              <td className="px-2">
                <TypeChip type={f.type} />
              </td>
              <td className="px-2 text-[12px]">{f.required ? 'required' : <span className="text-subtle">optional</span>}</td>
              <td className="max-w-[360px] truncate px-2 text-muted" title={f.doc}>
                {f.doc ?? ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
