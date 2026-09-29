import { useMemo, useState } from 'react'
import { ArrowDownUp, ChevronRight, ChevronsDownUp, ChevronsUpDown, KeyRound, Layers, Search } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip } from '@/components/ui/tooltip'
import { TypeChip } from '@/components/ui/type-chip'
import { cn } from '@/lib/cn'
import { diffSchemas, flattenSchema, typeLabel, type FieldChange, type FlatField, type Schema } from '@/lib/iceberg'

export interface FieldMarkers {
  identifier?: Set<number>
  partition?: Map<number, string>
  sort?: Map<number, string>
}

function ChangeBadge({ change }: { change: FieldChange }) {
  switch (change.kind) {
    case 'added':
      return <Badge tone="success">added</Badge>
    case 'removed':
      return <Badge tone="danger">dropped</Badge>
    case 'renamed':
      return <Badge tone="accent">renamed</Badge>
    case 'type':
      return <Badge tone="warning">type changed</Badge>
    case 'nullability':
      return <Badge tone="warning">nullability</Badge>
    case 'doc':
      return <Badge>doc</Badge>
  }
}

function describe(c: FieldChange): string {
  switch (c.kind) {
    case 'added':
      return `${c.field.path.join('.')} (${typeLabel(c.field.type)})`
    case 'removed':
      return c.field.path.join('.')
    case 'renamed':
      return `${c.from.path.join('.')} → ${c.to.path.join('.')}`
    case 'type':
      return `${c.to.path.join('.')}: ${typeLabel(c.from.type)} → ${typeLabel(c.to.type)}`
    case 'nullability':
      return `${c.to.path.join('.')}: ${c.from.required ? 'required' : 'optional'} → ${c.to.required ? 'required' : 'optional'}`
    case 'doc':
      return `${c.to.path.join('.')}: documentation updated`
  }
}

/**
 * Tree-table of a (possibly nested) Iceberg schema with version history.
 * Fields are identified by id, so renames are tracked across versions.
 */
export function SchemaTree({ schemas, currentId, markers }: { schemas: Schema[]; currentId: number; markers?: FieldMarkers }) {
  const ordered = useMemo(() => [...schemas].sort((a, b) => a['schema-id'] - b['schema-id']), [schemas])
  const [selectedId, setSelectedId] = useState(currentId)
  const schema = ordered.find((s) => s['schema-id'] === selectedId) ?? ordered[ordered.length - 1]
  const idx = ordered.indexOf(schema)
  const prev = idx > 0 ? ordered[idx - 1] : undefined
  const changes = useMemo(() => (prev ? diffSchemas(prev, schema) : []), [prev, schema])
  const changedIds = useMemo(() => {
    const m = new Map<number, FieldChange>()
    for (const c of changes) if (c.kind !== 'removed') m.set(c.kind === 'added' ? c.field.id : c.to.id, c)
    return m
  }, [changes])

  const flat = useMemo(() => flattenSchema(schema), [schema])
  const [collapsed, setCollapsed] = useState<Set<number>>(new Set())
  const [filter, setFilter] = useState('')
  const f = filter.trim().toLowerCase()
  const identifier = new Set(schema['identifier-field-ids'] ?? markers?.identifier ?? [])

  const visible: FlatField[] = []
  if (f) {
    for (const x of flat) if (x.path.join('.').toLowerCase().includes(f) || (x.doc ?? '').toLowerCase().includes(f)) visible.push(x)
  } else {
    const hiddenBelow: number[] = []
    for (const x of flat) {
      while (hiddenBelow.length && x.depth <= hiddenBelow[hiddenBelow.length - 1]) hiddenBelow.pop()
      if (hiddenBelow.length) continue
      visible.push(x)
      if (x.hasChildren && collapsed.has(x.id)) hiddenBelow.push(x.depth)
    }
  }
  const nestedIds = flat.filter((x) => x.hasChildren).map((x) => x.id)
  const topLevel = schema.fields.length

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter columns" aria-label="Filter columns" className="pl-8" />
        </div>
        {nestedIds.length > 0 && (
          <>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
              <ChevronsUpDown /> Expand all
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(nestedIds))}>
              <ChevronsDownUp /> Collapse all
            </Button>
          </>
        )}
        <div className="flex-1" />
        <span className="text-[12px] text-muted">
          {topLevel} columns · {flat.length} fields
        </span>
        {ordered.length > 1 && (
          <label className="flex items-center gap-2 text-[12px] text-muted">
            Schema version
            <select
              value={schema['schema-id']}
              onChange={(e) => setSelectedId(Number(e.target.value))}
              className="h-7 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12px] text-fg"
              aria-label="Schema version"
            >
              {[...ordered].reverse().map((s) => (
                <option key={s['schema-id']} value={s['schema-id']}>
                  {s['schema-id']}
                  {s['schema-id'] === currentId ? ' (current)' : ''}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {prev && changes.length > 0 && (
        <div className="rounded-[var(--radius-card)] border border-border bg-bg-subtle px-3 py-2.5">
          <div className="mb-1.5 text-[12px] font-medium">
            Changes from schema {prev['schema-id']} → {schema['schema-id']}
          </div>
          <ul className="flex flex-col gap-1">
            {changes.map((c, i) => (
              <li key={i} className="flex items-center gap-2 text-[12.5px]">
                <ChangeBadge change={c} />
                <span className="font-mono text-[12px]">{describe(c)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
        <table className="w-full border-collapse text-[13px]" role="treegrid" aria-label="Schema">
          <thead className="bg-bg-subtle">
            <tr className="border-b border-border text-left text-[11.5px] font-medium text-muted">
              <th className="h-8 w-14 px-3 text-right">ID</th>
              <th className="px-3">Column</th>
              <th className="px-3">Type</th>
              <th className="px-3">Nullability</th>
              <th className="px-3">Description</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((x) => {
              const open = !collapsed.has(x.id)
              const change = changedIds.get(x.id)
              return (
                <tr key={x.path.join('.')} className={cn('border-b border-border last:border-0 hover:bg-bg-subtle', change?.kind === 'added' && 'bg-success-subtle/50')}>
                  <td className="h-8 px-3 text-right font-mono text-[11.5px] text-subtle tabular">{x.id}</td>
                  <td className="px-3">
                    <div className="flex items-center gap-1" style={{ paddingLeft: f ? 0 : x.depth * 18 }}>
                      {x.hasChildren && !f ? (
                        <button
                          type="button"
                          aria-label={open ? `Collapse ${x.name}` : `Expand ${x.name}`}
                          aria-expanded={open}
                          onClick={() =>
                            setCollapsed((s) => {
                              const n = new Set(s)
                              if (n.has(x.id)) n.delete(x.id)
                              else n.add(x.id)
                              return n
                            })
                          }
                          className="rounded p-0.5 text-subtle hover:text-fg"
                        >
                          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
                        </button>
                      ) : (
                        <span className="inline-block w-[18px]" />
                      )}
                      <span className={cn('font-mono text-[12.5px]', x.role ? 'italic text-muted' : 'font-medium')}>{f ? x.path.join('.') : x.name}</span>
                      {identifier.has(x.id) && (
                        <Tooltip content="Identifier field (row key)">
                          <KeyRound className="size-3.5 text-warning" aria-label="Identifier field" />
                        </Tooltip>
                      )}
                      {markers?.partition?.has(x.id) && (
                        <Tooltip content={`Partitioned by ${markers.partition.get(x.id)}`}>
                          <Layers className="size-3.5 text-ent-namespace" aria-label="Partition source" />
                        </Tooltip>
                      )}
                      {markers?.sort?.has(x.id) && (
                        <Tooltip content={`Sort order: ${markers.sort.get(x.id)}`}>
                          <ArrowDownUp className="size-3.5 text-info" aria-label="Sort field" />
                        </Tooltip>
                      )}
                      {change && change.kind !== 'doc' && <ChangeBadge change={change} />}
                    </div>
                  </td>
                  <td className="max-w-[320px] px-3">
                    <TypeChip type={x.type} />
                  </td>
                  <td className="px-3 text-[12px]">{x.required ? <span className="font-medium">required</span> : <span className="text-subtle">optional</span>}</td>
                  <td className="max-w-[360px] truncate px-3 text-[12.5px] text-muted" title={x.doc}>
                    {x.doc ?? ''}
                  </td>
                </tr>
              )
            })}
            {visible.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-[12.5px] text-subtle">
                  No columns match “{filter}”.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
