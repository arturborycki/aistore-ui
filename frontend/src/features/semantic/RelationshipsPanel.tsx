import { useMemo, useState } from 'react'
import { ArrowRight, Lightbulb, Pencil, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState } from '@/components/ui/states'
import { cn } from '@/lib/cn'
import { layoutDiagram, suggestRelationships, uniqueName, type ORelationship, type OssieModel, type Problem } from '@/lib/ossie'
import { AIContextEditor } from './AIContextEditor'

/** Datasets as boxes (key columns listed), relationships as many→one arrows. */
function Diagram({ model, highlight, onSelect }: { model: OssieModel; highlight?: number; onSelect: (i: number) => void }) {
  const { nodes, width, height } = useMemo(() => layoutDiagram(model), [model])
  const rels = model.relationships ?? []
  const pad = 12
  const byName = new Map(nodes.map((n) => [n.name, n]))
  const keysOf = (name: string) => {
    const d = model.datasets.find((x) => x.name === name)!
    return [...new Set([...(d.primary_key ?? []), ...rels.flatMap((r) => (r.from === name ? r.from_columns : r.to === name ? r.to_columns : []))])].slice(0, 6)
  }
  return (
    <div className="overflow-auto rounded-[var(--radius-control)] border border-border bg-bg-subtle">
      <svg width={width + pad * 2} height={height + pad * 2} role="img" aria-label="Relationship diagram">
        <defs>
          <marker id="rel-one" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" className="fill-muted" />
          </marker>
        </defs>
        <g transform={`translate(${pad},${pad})`}>
          {rels.map((r, i) => {
            const a = byName.get(r.from)
            const b = byName.get(r.to)
            if (!a || !b) return null
            const leftToRight = a.x > b.x
            const x1 = leftToRight ? a.x : a.x + a.w
            const x2 = leftToRight ? b.x + b.w : b.x
            const y1 = a.y + 22
            const y2 = b.y + 22
            const mx = (x1 + x2) / 2
            const d = a.x === b.x ? `M${a.x + a.w},${y1} C${a.x + a.w + 40},${y1} ${b.x + b.w + 40},${y2} ${b.x + b.w},${y2}` : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`
            return (
              <g key={i} className="cursor-pointer" onClick={() => onSelect(i)}>
                <path d={d} fill="none" strokeWidth={highlight === i ? 2.5 : 1.5} className={highlight === i ? 'stroke-accent' : 'stroke-border-strong'} markerEnd="url(#rel-one)" />
                <title>{`${r.name}: ${r.from}(${r.from_columns.join(', ')}) → ${r.to}(${r.to_columns.join(', ')})`}</title>
              </g>
            )
          })}
          {nodes.map((n) => (
            <g key={n.name} transform={`translate(${n.x},${n.y})`}>
              <rect width={n.w} height={n.h} rx={6} className="fill-bg stroke-border" />
              <rect width={n.w} height={26} rx={6} className="fill-surface" />
              <text x={10} y={17} className="fill-fg font-mono text-[12px] font-semibold">
                {n.name.length > 24 ? `${n.name.slice(0, 23)}…` : n.name}
              </text>
              {keysOf(n.name).map((k, i) => (
                <text key={k} x={10} y={44 + i * 18} className="fill-muted font-mono text-[11px]">
                  {(model.datasets.find((d) => d.name === n.name)?.primary_key ?? []).includes(k) ? 'PK ' : 'FK '}
                  {k.length > 26 ? `${k.slice(0, 25)}…` : k}
                </text>
              ))}
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}

function ColumnsPicker({ fields, value, onChange, label }: { fields: string[]; value: string[]; onChange: (v: string[]) => void; label: string }) {
  return (
    <div className="flex flex-col gap-1" role="group" aria-label={label}>
      {value.map((c, i) => (
        <div key={i} className="flex items-center gap-1">
          <select
            aria-label={`${label} ${i + 1}`}
            value={c}
            onChange={(e) => onChange(value.map((x, j) => (j === i ? e.target.value : x)))}
            className="h-8 flex-1 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]"
          >
            {!fields.includes(c) && <option value={c}>{c || '—'}</option>}
            {fields.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          {value.length > 1 && (
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${label} ${i + 1}`} onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          )}
        </div>
      ))}
    </div>
  )
}

function RelationshipDialog({ model, value, onSave, onOpenChange }: { model: OssieModel; value: ORelationship; onSave: (r: ORelationship) => void; onOpenChange: (v: boolean) => void }) {
  const [r, setR] = useState(value)
  const fieldsOf = (ds: string) => model.datasets.find((d) => d.name === ds)?.fields?.map((f) => f.name) ?? []
  const keyOf = (ds: string) => model.datasets.find((d) => d.name === ds)?.primary_key ?? []
  const ok = r.name.trim() && r.from && r.to && r.from_columns.length === r.to_columns.length && r.from_columns.every(Boolean) && r.to_columns.every(Boolean)
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent title={value.name ? `Relationship ${value.name}` : 'New relationship'} description="A foreign key: many rows of the first dataset refer to one row of the second." wide>
        <DialogBody>
          <Field label="Name">{(p) => <Input {...p} value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} className="font-mono" />}</Field>
          <div className="grid items-start gap-3 md:grid-cols-[1fr_auto_1fr]">
            <div className="flex flex-col gap-2">
              <Field label="From (many side)">
                {(p) => (
                  <select {...p} value={r.from} onChange={(e) => setR({ ...r, from: e.target.value, from_columns: r.to_columns.map(() => '') })} className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]">
                    {model.datasets.map((d) => (
                      <option key={d.name}>{d.name}</option>
                    ))}
                  </select>
                )}
              </Field>
              <ColumnsPicker label="From column" fields={fieldsOf(r.from)} value={r.from_columns} onChange={(c) => setR({ ...r, from_columns: c })} />
            </div>
            <ArrowRight className="mt-8 hidden size-4 text-muted md:block" />
            <div className="flex flex-col gap-2">
              <Field label="To (one side)">
                {(p) => (
                  <select
                    {...p}
                    value={r.to}
                    onChange={(e) => {
                      const pk = keyOf(e.target.value)
                      setR({ ...r, to: e.target.value, to_columns: pk.length ? pk : [''], from_columns: (pk.length ? pk : ['']).map((c, i) => r.from_columns[i] ?? (fieldsOf(r.from).includes(c) ? c : '')) })
                    }}
                    className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]"
                  >
                    {model.datasets.map((d) => (
                      <option key={d.name}>{d.name}</option>
                    ))}
                  </select>
                )}
              </Field>
              <ColumnsPicker label="To column" fields={fieldsOf(r.to)} value={r.to_columns} onChange={(c) => setR({ ...r, to_columns: c })} />
            </div>
          </div>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setR({ ...r, from_columns: [...r.from_columns, ''], to_columns: [...r.to_columns, ''] })}>
              <Plus /> Add column pair (composite key)
            </Button>
          </div>
          <AIContextEditor subject={r.name || 'this relationship'} value={r.ai_context} onChange={(v) => setR({ ...r, ai_context: v })} examples={false} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={() => onSave({ ...r, name: r.name.trim() })}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RelationshipsPanel({ model, setDraft, problems }: { model: OssieModel; setDraft: (f: (m: OssieModel) => OssieModel) => void; problems: Problem[] }) {
  const rels = model.relationships ?? []
  const [editing, setEditing] = useState<{ index: number; value: ORelationship } | null>(null)
  const [highlight, setHighlight] = useState<number>()
  const suggestions = useMemo(() => suggestRelationships(model), [model])
  const setRels = (f: (r: ORelationship[]) => ORelationship[]) => setDraft((m) => ({ ...m, relationships: f(m.relationships ?? []) }))
  const newRel = (): ORelationship => {
    const to = model.datasets[0]
    const from = model.datasets[1] ?? to
    const pk = to?.primary_key?.length ? to.primary_key : ['']
    return { name: uniqueName(`${from?.name}_${to?.name}`, rels.map((r) => r.name)), from: from?.name ?? '', to: to?.name ?? '', from_columns: pk.map(() => ''), to_columns: pk }
  }
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Relationships"
          description="Arrows point from the many side to the one side. Click an arrow to edit it."
          actions={
            <Button size="sm" variant="primary" disabled={model.datasets.length === 0} onClick={() => setEditing({ index: -1, value: newRel() })}>
              <Plus /> Add relationship
            </Button>
          }
        />
        <div className="p-3">
          {model.datasets.length > 0 && <Diagram model={model} highlight={highlight} onSelect={(i) => setEditing({ index: i, value: rels[i] })} />}
        </div>
      </Card>
      {suggestions.length > 0 && (
        <Card>
          <CardHeader title={<span className="flex items-center gap-1.5"><Lightbulb className="size-4 text-warning" /> Suggested joins</span>} description="Fields whose name and type match another dataset's key." />
          <ul className="divide-y divide-border">
            {suggestions.map((s, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2 text-[12.5px]">
                <span className="font-mono">
                  {s.from}.{s.from_columns.join(', ')} → {s.to}.{s.to_columns.join(', ')}
                </span>
                <span className="text-muted">{s.reason}</span>
                <Button
                  size="sm"
                  variant="outline"
                  className="ml-auto"
                  onClick={() => setRels((r) => [...r, { name: uniqueName(`${s.from}_${s.to}`, r.map((x) => x.name)), from: s.from, to: s.to, from_columns: s.from_columns, to_columns: s.to_columns }])}
                >
                  <Plus /> Add
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <Card>
        {rels.length === 0 ? (
          <EmptyState title="No relationships" className="m-3 border-0">
            Relationships tell tools how to join datasets, for example orders.customer_id → customers.customer_id.
          </EmptyState>
        ) : (
          <table className="w-full text-[12.5px]">
            <thead className="bg-bg-subtle text-left text-[11.5px] text-muted">
              <tr>
                <th className="h-8 px-4 font-medium">Name</th>
                <th className="px-2 font-medium">From (many)</th>
                <th className="px-2 font-medium">To (one)</th>
                <th className="w-24" />
              </tr>
            </thead>
            <tbody>
              {rels.map((r, i) => {
                const p = problems.find((x) => x.path.startsWith(`relationships[${i}]`))
                return (
                  <tr key={i} className={cn('border-t border-border', p && 'bg-warning-subtle/50')} onMouseEnter={() => setHighlight(i)} onMouseLeave={() => setHighlight(undefined)}>
                    <td className="px-4 py-2 font-mono">
                      {r.name}
                      {p && <div className="font-sans text-[11.5px] text-warning">{p.message}</div>}
                    </td>
                    <td className="px-2 font-mono">
                      {r.from}({r.from_columns.join(', ')})
                    </td>
                    <td className="px-2 font-mono">
                      {r.to}({r.to_columns.join(', ')})
                    </td>
                    <td className="whitespace-nowrap px-2 text-right">
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit relationship ${r.name}`} onClick={() => setEditing({ index: i, value: r })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove relationship ${r.name}`} onClick={() => setRels((x) => x.filter((_, j) => j !== i))}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      {editing && (
        <RelationshipDialog
          model={model}
          value={editing.value}
          onOpenChange={(v) => !v && setEditing(null)}
          onSave={(r) => {
            setRels((x) => (editing.index < 0 ? [...x, r] : x.map((y, j) => (j === editing.index ? r : y))))
            setEditing(null)
          }}
        />
      )}
    </div>
  )
}
