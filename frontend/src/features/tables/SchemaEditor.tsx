import { ArrowDown, ArrowUp, Plus, Trash2, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { cn } from '@/lib/cn'
import { canPromote, newField, PRIMITIVES, type EField, type EType, type SchemaProblem } from '@/lib/schemaModel'

/** Field tree with a "dropped" marker used by the evolution editor. */
export type DraftField = EField & { dropped?: boolean }

const NESTED = ['struct', 'list', 'map'] as const

function kindOf(t: EType): string {
  if (t.kind !== 'primitive') return t.kind
  if (t.name.startsWith('decimal')) return 'decimal'
  if (t.name.startsWith('fixed')) return 'fixed'
  return t.name
}

function makeType(kind: string, prev?: EType): EType {
  switch (kind) {
    case 'struct':
      return { kind: 'struct', fields: [newField('field_1')] }
    case 'list':
      return { kind: 'list', element: { kind: 'primitive', name: 'string' }, elementRequired: false }
    case 'map':
      return { kind: 'map', key: { kind: 'primitive', name: 'string' }, value: { kind: 'primitive', name: 'string' }, valueRequired: false }
    case 'decimal':
      return prev?.kind === 'primitive' && prev.name.startsWith('decimal') ? prev : { kind: 'primitive', name: 'decimal(10, 2)' }
    case 'fixed':
      return prev?.kind === 'primitive' && prev.name.startsWith('fixed') ? prev : { kind: 'primitive', name: 'fixed[16]' }
    default:
      return { kind: 'primitive', name: kind }
  }
}

const baseKinds = [...new Set(PRIMITIVES.map((p) => (p.startsWith('decimal') ? 'decimal' : p.startsWith('fixed') ? 'fixed' : p)))]

/** Type picker; `allowed` restricts choices (e.g. to legal promotions). */
function TypePicker({ value, onChange, allowed, label, nested = true }: { value: EType; onChange: (t: EType) => void; allowed?: string[]; label: string; nested?: boolean }) {
  const kind = kindOf(value)
  const options = allowed ?? [...baseKinds, ...(nested ? NESTED : [])]
  const dec = value.kind === 'primitive' ? /^decimal\((\d+),\s*(\d+)\)$/.exec(value.name) : null
  const fix = value.kind === 'primitive' ? /^fixed\[(\d+)\]$/.exec(value.name) : null
  return (
    <span className="inline-flex items-center gap-1">
      <select
        aria-label={label}
        value={kind}
        onChange={(e) => onChange(makeType(e.target.value, value))}
        className="h-7 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 font-mono text-[12px]"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
      {dec && (
        <>
          <input
            aria-label={`${label} precision`}
            type="number"
            min={1}
            max={38}
            value={dec[1]}
            onChange={(e) => onChange({ kind: 'primitive', name: `decimal(${e.target.value}, ${dec[2]})` })}
            className="h-7 w-14 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 font-mono text-[12px]"
          />
          <input
            aria-label={`${label} scale`}
            type="number"
            min={0}
            max={38}
            value={dec[2]}
            disabled={!!allowed}
            onChange={(e) => onChange({ kind: 'primitive', name: `decimal(${dec[1]}, ${e.target.value})` })}
            className="h-7 w-12 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 font-mono text-[12px] disabled:opacity-50"
          />
        </>
      )}
      {fix && !allowed && (
        <input
          aria-label={`${label} length`}
          type="number"
          min={1}
          value={fix[1]}
          onChange={(e) => onChange({ kind: 'primitive', name: `fixed[${e.target.value}]` })}
          className="h-7 w-16 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 font-mono text-[12px]"
        />
      )}
    </span>
  )
}

interface RowProps {
  field: DraftField
  depth: number
  evolution: boolean
  formatVersion: number
  problems: Map<string, string>
  onChange: (f: DraftField) => void
  onRemove: () => void
  onMove: (dir: -1 | 1) => void
  first: boolean
  last: boolean
}

/** Allowed type choices for an existing primitive column during evolution. */
function promotionsFor(from: string, fv: number): string[] {
  const kinds = new Set<string>()
  for (const k of baseKinds) {
    const probe = k === 'decimal' ? from : k === 'fixed' ? 'fixed[1]' : k
    if (canPromote(from, probe, fv)) kinds.add(k)
  }
  kinds.add(kindOf({ kind: 'primitive', name: from }))
  return [...kinds]
}

function FieldRow({ field: f, depth, evolution, formatVersion, problems, onChange, onRemove, onMove, first, last }: RowProps) {
  const isNew = !f.origin
  const origType = f.origin?.type
  const renamed = f.origin && f.origin.name !== f.name.trim()
  const retyped = f.origin && typeof origType === 'string' && f.type.kind === 'primitive' && f.type.name !== origType
  const madeOptional = f.origin?.required && !f.required
  const problem = problems.get(f.uid)
  const allowed = evolution && f.origin ? (typeof origType === 'string' ? promotionsFor(origType, formatVersion) : [f.type.kind]) : undefined

  // Children for nested types: struct fields directly, list<struct>/map<_, struct> through element/value.
  const childStruct = f.type.kind === 'struct' ? f.type : f.type.kind === 'list' && f.type.element.kind === 'struct' ? f.type.element : f.type.kind === 'map' && f.type.value.kind === 'struct' ? f.type.value : null
  const setChildren = (fields: EField[]) => {
    const t = f.type
    if (t.kind === 'struct') onChange({ ...f, type: { ...t, fields } })
    else if (t.kind === 'list' && t.element.kind === 'struct') onChange({ ...f, type: { ...t, element: { kind: 'struct', fields } } })
    else if (t.kind === 'map' && t.value.kind === 'struct') onChange({ ...f, type: { ...t, value: { kind: 'struct', fields } } })
  }

  return (
    <>
      <tr className={cn('border-b border-border last:border-0', f.dropped && 'bg-danger-subtle/60', isNew && evolution && 'bg-success-subtle/40', problem && 'bg-warning-subtle/50')}>
        <td className="px-2 py-1">
          <div className="flex items-center gap-1" style={{ paddingLeft: depth * 18 }}>
            <input
              aria-label="Column name"
              value={f.name}
              disabled={f.dropped}
              onChange={(e) => onChange({ ...f, name: e.target.value })}
              placeholder="column_name"
              spellCheck={false}
              className={cn('h-7 w-full min-w-[140px] rounded-[var(--radius-control)] border border-transparent bg-transparent px-1.5 font-mono text-[12.5px] hover:border-border focus:border-accent focus:outline-none', f.dropped && 'line-through')}
            />
            {evolution && isNew && <Badge tone="success">new</Badge>}
            {renamed && <Tooltip content={`was ${f.origin!.name}`}><span><Badge tone="accent">renamed</Badge></span></Tooltip>}
            {retyped && <Badge tone="warning">widened</Badge>}
            {madeOptional && <Badge tone="warning">optional</Badge>}
            {f.dropped && <Badge tone="danger">dropped</Badge>}
          </div>
          {problem && <div className="px-1.5 pb-1 text-[11.5px] text-warning" style={{ paddingLeft: depth * 18 + 6 }}>{problem}</div>}
        </td>
        <td className="px-2 py-1">
          {!f.dropped && (
            <span className="flex flex-wrap items-center gap-1">
              <TypePicker label={`Type of ${f.name || 'column'}`} value={f.type} allowed={allowed} onChange={(type) => onChange({ ...f, type })} />
              {f.type.kind === 'list' && (
                <>
                  <span className="text-[11px] text-subtle">of</span>
                  <TypePicker
                    label={`Element type of ${f.name}`}
                    value={f.type.element}
                    allowed={evolution && f.origin ? [kindOf(f.type.element)] : undefined}
                    onChange={(element) => f.type.kind === 'list' && onChange({ ...f, type: { ...f.type, element } })}
                  />
                </>
              )}
              {f.type.kind === 'map' && (
                <>
                  <span className="text-[11px] text-subtle">key</span>
                  <TypePicker label={`Key type of ${f.name}`} value={f.type.key} nested={false} allowed={evolution && f.origin ? [kindOf(f.type.key)] : undefined} onChange={(key) => f.type.kind === 'map' && onChange({ ...f, type: { ...f.type, key } })} />
                  <span className="text-[11px] text-subtle">value</span>
                  <TypePicker label={`Value type of ${f.name}`} value={f.type.value} allowed={evolution && f.origin ? [kindOf(f.type.value)] : undefined} onChange={(value) => f.type.kind === 'map' && onChange({ ...f, type: { ...f.type, value } })} />
                </>
              )}
            </span>
          )}
        </td>
        <td className="px-2 py-1 text-center">
          <Tooltip content={evolution && isNew ? 'New columns must be optional' : evolution && f.origin && !f.origin.required ? 'Optional columns cannot become required' : 'Required (NOT NULL)'}>
            <span className="inline-flex">
              <Checkbox
                checked={f.required}
                onCheckedChange={(v) => onChange({ ...f, required: v })}
                className={cn((f.dropped || (evolution && (isNew || !f.origin?.required))) && 'pointer-events-none opacity-40')}
              />
            </span>
          </Tooltip>
        </td>
        <td className="px-2 py-1">
          <input
            aria-label={`Description of ${f.name || 'column'}`}
            value={f.doc ?? ''}
            disabled={f.dropped}
            onChange={(e) => onChange({ ...f, doc: e.target.value })}
            placeholder="description"
            className="h-7 w-full min-w-[120px] rounded-[var(--radius-control)] border border-transparent bg-transparent px-1.5 text-[12.5px] hover:border-border focus:border-accent focus:outline-none"
          />
        </td>
        <td className="whitespace-nowrap px-1 py-1 text-right">
          {!f.dropped && (
            <>
              <Button size="icon-sm" variant="ghost" aria-label={`Move ${f.name} up`} disabled={first} onClick={() => onMove(-1)}>
                <ArrowUp />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label={`Move ${f.name} down`} disabled={last} onClick={() => onMove(1)}>
                <ArrowDown />
              </Button>
            </>
          )}
          {f.dropped ? (
            <Button size="icon-sm" variant="ghost" aria-label={`Restore ${f.name}`} onClick={() => onChange({ ...f, dropped: false })}>
              <Undo2 />
            </Button>
          ) : (
            <Button size="icon-sm" variant="ghost" aria-label={`Remove ${f.name || 'column'}`} onClick={onRemove}>
              <Trash2 />
            </Button>
          )}
        </td>
      </tr>
      {childStruct && !f.dropped && (
        <FieldRows
          fields={childStruct.fields as DraftField[]}
          depth={depth + 1}
          evolution={evolution}
          formatVersion={formatVersion}
          problems={problems}
          onChange={setChildren}
          addLabel={`Add field to ${f.name || 'struct'}`}
        />
      )}
    </>
  )
}

function FieldRows({
  fields,
  depth,
  evolution,
  formatVersion,
  problems,
  onChange,
  addLabel,
}: {
  fields: DraftField[]
  depth: number
  evolution: boolean
  formatVersion: number
  problems: Map<string, string>
  onChange: (f: DraftField[]) => void
  addLabel: string
}) {
  return (
    <>
      {fields.map((f, i) => (
        <FieldRow
          key={f.uid}
          field={f}
          depth={depth}
          evolution={evolution}
          formatVersion={formatVersion}
          problems={problems}
          first={i === 0}
          last={i === fields.length - 1}
          onChange={(nf) => onChange(fields.map((x, j) => (j === i ? nf : x)))}
          onRemove={() => onChange(f.origin ? fields.map((x, j) => (j === i ? { ...x, dropped: true } : x)) : fields.filter((_, j) => j !== i))}
          onMove={(d) => {
            const next = [...fields]
            const [x] = next.splice(i, 1)
            next.splice(i + d, 0, x)
            onChange(next)
          }}
        />
      ))}
      <tr>
        <td colSpan={5} className="px-2 py-1">
          <div style={{ paddingLeft: depth * 18 }}>
            <Button size="sm" variant="ghost" onClick={() => onChange([...fields, newField(`column_${fields.length + 1}`)])}>
              <Plus /> {addLabel}
            </Button>
          </div>
        </td>
      </tr>
    </>
  )
}

/**
 * Editable schema grid. In evolution mode existing columns can be renamed,
 * widened (allowed promotions only), made optional, documented, reordered or
 * dropped; new columns are always optional.
 */
export function SchemaEditor({
  fields,
  onChange,
  problems,
  evolution = false,
  formatVersion = 2,
}: {
  fields: DraftField[]
  onChange: (f: DraftField[]) => void
  problems: SchemaProblem[]
  evolution?: boolean
  formatVersion?: number
}) {
  const byUid = new Map<string, string>()
  for (const p of problems) if (!byUid.has(p.uid)) byUid.set(p.uid, p.message)
  return (
    <div className="overflow-x-auto rounded-[var(--radius-card)] border border-border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="bg-bg-subtle">
          <tr className="border-b border-border text-left text-[11.5px] font-medium text-muted">
            <th className="h-8 px-3">Column</th>
            <th className="px-3">Type</th>
            <th className="w-20 px-3 text-center">Required</th>
            <th className="px-3">Description</th>
            <th className="w-28" />
          </tr>
        </thead>
        <tbody>
          <FieldRows fields={fields} depth={0} evolution={evolution} formatVersion={formatVersion} problems={byUid} onChange={onChange} addLabel="Add column" />
        </tbody>
      </table>
    </div>
  )
}

/** Removes fields marked as dropped (recursively). */
export function withoutDropped(fields: DraftField[]): EField[] {
  const strip = (t: EType): EType => {
    if (t.kind === 'struct') return { ...t, fields: withoutDropped(t.fields as DraftField[]) }
    if (t.kind === 'list') return { ...t, element: strip(t.element) }
    if (t.kind === 'map') return { ...t, value: strip(t.value) }
    return t
  }
  return fields.filter((f) => !f.dropped).map(({ dropped: _d, ...f }) => ({ ...f, type: strip(f.type) }))
}
