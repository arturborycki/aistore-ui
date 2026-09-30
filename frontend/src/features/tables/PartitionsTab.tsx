import { ArrowDown, ArrowUp, Layers, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState } from '@/components/ui/states'
import { fieldNames, transformLabel, type Schema, type TableMetadata } from '@/lib/iceberg'

export function PartitionsTab({ md, schema, onEvolveSpec, onEvolveSort }: { md: TableMetadata; schema: Schema; onEvolveSpec?: () => void; onEvolveSort?: () => void }) {
  const names = fieldNames(schema)
  const col = (id: number) => names.get(id) ?? `#${id} (dropped)`
  const specs = [...md['partition-specs']].sort((a, b) => b['spec-id'] - a['spec-id'])
  const orders = [...(md['sort-orders'] ?? [])].sort((a, b) => b['order-id'] - a['order-id'])

  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader
          title="Partition specs"
          description="New data is written with the default spec; older files keep the spec they were written with."
          actions={onEvolveSpec && <Button size="sm" variant="outline" onClick={onEvolveSpec}><Pencil /> Evolve</Button>}
        />
        <div className="flex flex-col divide-y divide-border">
          {specs.map((s) => {
            const isDefault = s['spec-id'] === md['default-spec-id']
            return (
              <div key={s['spec-id']} className="px-4 py-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="font-mono text-[12.5px] font-medium">spec {s['spec-id']}</span>
                  {isDefault && <Badge tone="accent">default</Badge>}
                  {s.fields.length === 0 && <Badge>unpartitioned</Badge>}
                </div>
                {s.fields.length > 0 && (
                  <table className="w-full text-[12.5px]">
                    <thead>
                      <tr className="text-left text-[11px] text-subtle">
                        <th className="pb-1 font-medium">Partition field</th>
                        <th className="pb-1 font-medium">Expression</th>
                        <th className="pb-1 text-right font-medium">Field ID</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.fields.map((f) => (
                        <tr key={f['field-id']}>
                          <td className="py-1 font-mono">{f.name}</td>
                          <td className="py-1 font-mono text-accent-text">{transformLabel(f.transform, col(f['source-id']))}</td>
                          <td className="py-1 text-right font-mono text-subtle">{f['field-id']}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )
          })}
          {specs.length === 0 && <EmptyState icon={<Layers />} title="Unpartitioned" className="m-4" />}
        </div>
      </Card>
      <Card>
        <CardHeader
          title="Sort orders"
          description="How writers order rows within data files."
          actions={onEvolveSort && <Button size="sm" variant="outline" onClick={onEvolveSort}><Pencil /> Change</Button>}
        />
        <div className="flex flex-col divide-y divide-border">
          {orders.map((o) => (
            <div key={o['order-id']} className="px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="font-mono text-[12.5px] font-medium">order {o['order-id']}</span>
                {o['order-id'] === md['default-sort-order-id'] && <Badge tone="accent">default</Badge>}
                {o.fields.length === 0 && <Badge>unsorted</Badge>}
              </div>
              <ol className="flex flex-col gap-1">
                {o.fields.map((f, i) => (
                  <li key={i} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-4 text-right text-subtle tabular">{i + 1}.</span>
                    {f.direction === 'asc' ? <ArrowUp className="size-3.5 text-muted" /> : <ArrowDown className="size-3.5 text-muted" />}
                    <span className="font-mono">{transformLabel(f.transform, col(f['source-id']))}</span>
                    <span className="text-muted">
                      {f.direction} · {f['null-order'].replace('-', ' ')}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
          {orders.length === 0 && <p className="p-4 text-[12.5px] text-subtle">No sort orders defined.</p>}
        </div>
      </Card>
    </div>
  )
}
