import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { ArrowDownUp, BarChart3, BookOpenText, History, KeyRound, Layers, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { KeyValue } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tooltip } from '@/components/ui/tooltip'
import { TypeChip } from '@/components/ui/type-chip'
import type { InspectColumn, InspectResult } from '@/lib/catalog'
import { formatBytes, formatNumber } from '@/lib/format'
import { fieldHistory, flattenSchema, transformLabel, type Schema, type TableMetadata } from '@/lib/iceberg'
import { ossie, semanticKeys } from '@/lib/ossie'
import { paths } from '@/layout/paths'
import { useSemanticEnabled } from '@/features/semantic/ModelsTab'

function pct(part?: number, whole?: number) {
  if (part == null || !whole) return ''
  const p = (part / whole) * 100
  return p === 0 ? '0%' : p < 0.1 ? '<0.1%' : `${p.toFixed(p < 10 ? 1 : 0)}%`
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2 border-t border-border px-4 py-3">
      <h3 className="flex items-center gap-1.5 text-[11.5px] font-medium uppercase tracking-wide text-subtle [&_svg]:size-3.5">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Statistics of one column from the data files' metrics (a snapshot). */
export function ColumnStats({ col, result }: { col?: InspectColumn; result: InspectResult }) {
  if (!col || col.filesWithStats === 0) {
    return <p className="text-[12.5px] text-subtle">No statistics recorded for this column{result.summary.dataFiles === 0 ? ' (the snapshot has no data files)' : ''}.</p>
  }
  const total = result.summary.dataSize
  return (
    <KeyValue
      items={[
        { label: 'Values', value: formatNumber(col.valueCount) },
        { label: 'Nulls', value: col.nullCount != null ? `${formatNumber(col.nullCount)} (${pct(col.nullCount, col.valueCount)})` : '—' },
        ...(col.nanCount != null ? [{ label: 'NaN', value: formatNumber(col.nanCount) }] : []),
        { label: 'Minimum', value: <span className="break-all font-mono text-[12px]">{col.lower ?? '—'}</span> },
        { label: 'Maximum', value: <span className="break-all font-mono text-[12px]">{col.upper ?? '—'}</span> },
        { label: 'Size on disk', value: col.size != null ? `${formatBytes(col.size)} (${pct(col.size, total)} of data)` : '—' },
        {
          label: 'Coverage',
          value: `${formatNumber(col.filesWithStats)} of ${formatNumber(result.summary.dataFiles)} files report metrics${result.truncated ? ' (sampled)' : ''}`,
        },
      ]}
    />
  )
}

export function ColumnDetail({
  md,
  schema,
  fieldId,
  cluster,
  wh,
  stats,
  onClose,
  onEvolve,
}: {
  md: TableMetadata
  schema: Schema
  fieldId: number
  cluster: string
  wh: string
  stats: { data?: InspectResult; error: unknown; isPending: boolean }
  onClose: () => void
  onEvolve: () => void
}) {
  const semantic = useSemanticEnabled()
  const usage = useQuery({
    queryKey: semanticKeys.usage(cluster, wh, md['table-uuid']),
    queryFn: () => ossie.usage(cluster, wh, { table: md['table-uuid'] }),
    enabled: semantic,
    staleTime: 60_000,
  })
  const flat = flattenSchema(schema)
  const f = flat.find((x) => x.id === fieldId)
  if (!f) {
    return (
      <aside className="rounded-[var(--radius-card)] border border-border p-4 text-[12.5px] text-muted">
        Column {fieldId} is not in schema {schema['schema-id']}.
      </aside>
    )
  }
  const nested = schema.fields && findNested(schema, fieldId)
  const idents = new Set(schema['identifier-field-ids'] ?? [])
  const currentSpec = md['default-spec-id']
  const partitionUses = md['partition-specs'].flatMap((s) => s.fields.filter((p) => p['source-id'] === fieldId).map((p) => ({ spec: s['spec-id'], label: transformLabel(p.transform, f.path.join('.')), name: p.name })))
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  const sortUse = order?.fields.findIndex((s) => s['source-id'] === fieldId) ?? -1
  const history = fieldHistory(md.schemas, fieldId)
  const col = stats.data?.columns.find((c) => c.id === fieldId)
  const models = (usage.data?.usage ?? []).flatMap((u) => u.fields.filter((x) => x.fieldId === fieldId).map((x) => ({ ...u, field: x.field })))

  return (
    <aside aria-label={`Column ${f.path.join('.')}`} className="flex flex-col self-start overflow-hidden rounded-[var(--radius-card)] border border-border bg-bg">
      <div className="flex items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="break-all font-mono text-[14px] font-semibold">{f.path.join('.')}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <TypeChip type={f.type} />
            <Badge>{f.required ? 'required' : 'optional'}</Badge>
            <span className="font-mono text-[11.5px] text-subtle">field id {f.id}</span>
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label="Close column details" onClick={onClose}>
          <X />
        </Button>
      </div>
      {f.doc && <p className="px-4 pb-3 text-[12.5px] text-muted">{f.doc}</p>}

      {(nested?.['initial-default'] !== undefined || nested?.['write-default'] !== undefined) && (
        <Section icon={<History />} title="Defaults">
          <KeyValue
            items={[
              ...(nested?.['initial-default'] !== undefined ? [{ label: 'Initial default', value: <span className="font-mono text-[12px]">{JSON.stringify(nested['initial-default'])}</span> }] : []),
              ...(nested?.['write-default'] !== undefined ? [{ label: 'Write default', value: <span className="font-mono text-[12px]">{JSON.stringify(nested['write-default'])}</span> }] : []),
            ]}
          />
        </Section>
      )}

      <Section icon={<Layers />} title="Role in the table">
        <ul className="flex flex-col gap-1 text-[12.5px]">
          {idents.has(fieldId) && (
            <li className="flex items-center gap-1.5">
              <KeyRound className="size-3.5 text-warning" /> Part of the row key (identifier fields)
            </li>
          )}
          {partitionUses.map((p) => (
            <li key={`${p.spec}-${p.name}`} className="flex items-center gap-1.5">
              <Layers className="size-3.5 text-ent-namespace" />
              <span>
                Partitioned by <span className="font-mono">{p.label}</span> in spec {p.spec}
              </span>
              {p.spec === currentSpec ? <Badge tone="accent">current</Badge> : <Badge>earlier</Badge>}
            </li>
          ))}
          {sortUse >= 0 && order && (
            <li className="flex items-center gap-1.5">
              <ArrowDownUp className="size-3.5 text-info" /> Sort key #{sortUse + 1}: {order.fields[sortUse].direction}, {order.fields[sortUse]['null-order']}
            </li>
          )}
          {!idents.has(fieldId) && partitionUses.length === 0 && sortUse < 0 && <li className="text-subtle">Not used by keys, partitioning or sort order.</li>}
        </ul>
      </Section>

      <Section icon={<BarChart3 />} title="Data statistics">
        {stats.isPending ? (
          <Skeleton className="h-24" />
        ) : stats.error ? (
          <ErrorState error={stats.error} compact />
        ) : stats.data ? (
          <>
            <ColumnStats col={col} result={stats.data} />
            {col?.boundsTruncated && <p className="text-[11.5px] text-subtle">Writers store only a prefix of long string and binary values, so minimum and maximum may be truncated.</p>}
          </>
        ) : null}
      </Section>

      <Section icon={<History />} title="History">
        <ol className="flex flex-col gap-1 text-[12.5px]">
          {history.map((h, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span className="shrink-0 whitespace-nowrap font-mono text-[11.5px] text-subtle">schema {h.schemaId}</span>
              <Badge tone={h.kind === 'added' ? 'success' : h.kind === 'dropped' ? 'danger' : h.kind === 'renamed' ? 'accent' : 'neutral'}>{h.kind}</Badge>
              <span className="min-w-0 break-all font-mono text-[12px]">{h.detail}</span>
            </li>
          ))}
        </ol>
      </Section>

      {semantic && (
        <Section icon={<BookOpenText />} title="Semantic models">
          {models.length === 0 ? (
            <p className="text-[12.5px] text-subtle">Not described in any semantic model.</p>
          ) : (
            <ul className="flex flex-col gap-1 text-[12.5px]">
              {models.map((m) => (
                <li key={`${m.model}/${m.dataset}/${m.field}`}>
                  <Link to={paths.model(cluster, m.warehouse, m.namespace, m.model, 'datasets')} className="font-mono text-accent-text hover:underline">
                    {m.model}
                  </Link>
                  <span className="text-muted">
                    {' '}
                    as {m.dataset}.{m.field}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}

      <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
        <Tooltip content="Rename, widen, document or drop this column">
          <Button size="sm" variant="outline" onClick={onEvolve}>
            Evolve schema…
          </Button>
        </Tooltip>
      </div>
    </aside>
  )
}

function findNested(s: Schema, id: number) {
  const walk = (fields: Schema['fields']): Schema['fields'][number] | undefined => {
    for (const f of fields) {
      if (f.id === id) return f
      if (typeof f.type !== 'string' && f.type.type === 'struct') {
        const x = walk(f.type.fields)
        if (x) return x
      }
    }
    return undefined
  }
  return walk(s.fields)
}
