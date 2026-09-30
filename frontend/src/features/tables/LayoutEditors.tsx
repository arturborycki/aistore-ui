import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { defaultPartitionName, transformsFor, type SpecFieldDraft } from '@/lib/commits'
import type { NestedField, SortField, StructType } from '@/lib/iceberg'

export interface SourceColumn {
  id: number
  name: string
  type: string
}

/** Primitive columns usable as partition / sort sources (not inside lists or maps). */
export function sourceColumns(s: StructType | { fields: NestedField[] }): SourceColumn[] {
  const out: SourceColumn[] = []
  const walk = (fs: NestedField[], prefix: string) =>
    fs.forEach((f) => {
      const name = prefix ? `${prefix}.${f.name}` : f.name
      if (typeof f.type === 'string') out.push({ id: f.id, name, type: f.type })
      else if (f.type.type === 'struct') walk(f.type.fields, name)
    })
  walk(s.fields, '')
  return out
}

const selectCls = 'h-7 rounded-[var(--radius-control)] border border-border bg-bg px-1.5 font-mono text-[12px]'

function transformValue(t: string): { base: string; arg: string } {
  const m = /^(bucket|truncate)\[(\d+)\]$/.exec(t)
  return m ? { base: m[1], arg: m[2] } : { base: t, arg: '' }
}

export function partitionProblems(fields: SpecFieldDraft[], cols: SourceColumn[]): string[] {
  const out: string[] = []
  const names = new Set<string>()
  const pairs = new Set<string>()
  const colNames = new Map(cols.map((c) => [c.name, c.id]))
  for (const f of fields) {
    if (!f.name.trim()) out.push('Every partition field needs a name')
    if (names.has(f.name)) out.push(`Duplicate partition field name "${f.name}"`)
    names.add(f.name)
    const clash = colNames.get(f.name)
    if (clash != null && !(f.transform === 'identity' && clash === f.sourceId)) out.push(`Partition field "${f.name}" collides with a column name`)
    const key = `${f.sourceId}|${f.transform}`
    if (pairs.has(key) && f.transform !== 'void') out.push('The same column and transform appear twice')
    pairs.add(key)
    const { base, arg } = transformValue(f.transform)
    if ((base === 'bucket' || base === 'truncate') && !(Number(arg) > 0)) out.push(`${base} needs a positive number`)
    if (!cols.some((c) => c.id === f.sourceId)) out.push(`Source column #${f.sourceId} no longer exists`)
  }
  return out
}

/** Edits partition fields (source column + transform). */
export function PartitionFieldsEditor({ cols, value, onChange, lockedIds = [] }: { cols: SourceColumn[]; value: SpecFieldDraft[]; onChange: (v: SpecFieldDraft[]) => void; lockedIds?: number[] }) {
  const set = (i: number, patch: Partial<SpecFieldDraft>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 && <p className="text-[12.5px] text-subtle">Unpartitioned. Add a field to partition data by a column.</p>}
      {value.map((f, i) => {
        const col = cols.find((c) => c.id === f.sourceId)
        const { base, arg } = transformValue(f.transform)
        const options = col ? transformsFor(col.type) : ['identity']
        const locked = f.fieldId != null && lockedIds.includes(f.fieldId)
        const rename = (transform: string, sourceId = f.sourceId) => {
          const src = cols.find((c) => c.id === sourceId)?.name ?? ''
          const auto = !f.name || f.name === defaultPartitionName(f.transform, col?.name ?? '')
          return auto ? defaultPartitionName(transform, src.replace(/\./g, '_')) : f.name
        }
        return (
          <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2 py-1.5">
            <select
              aria-label="Source column"
              className={selectCls}
              value={f.sourceId}
              disabled={locked}
              onChange={(e) => {
                const id = Number(e.target.value)
                const t = transformsFor(cols.find((c) => c.id === id)?.type ?? '').includes(base) ? f.transform : 'identity'
                set(i, { sourceId: id, transform: t, name: rename(t, id), fieldId: undefined })
              }}
            >
              {cols.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.type})
                </option>
              ))}
            </select>
            <select
              aria-label="Transform"
              className={selectCls}
              value={base}
              disabled={locked}
              onChange={(e) => {
                const b = e.target.value
                const t = b === 'bucket' ? 'bucket[16]' : b === 'truncate' ? 'truncate[10]' : b
                set(i, { transform: t, name: rename(t), fieldId: undefined })
              }}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
            {(base === 'bucket' || base === 'truncate') && (
              <input
                aria-label={base === 'bucket' ? 'Number of buckets' : 'Truncate width'}
                type="number"
                min={1}
                value={arg}
                disabled={locked}
                onChange={(e) => set(i, { transform: `${base}[${e.target.value}]`, fieldId: undefined })}
                className={`${selectCls} w-20`}
              />
            )}
            <span className="text-[12px] text-subtle">as</span>
            <input aria-label="Partition field name" value={f.name} onChange={(e) => set(i, { name: e.target.value })} className={`${selectCls} min-w-[140px] flex-1`} />
            <Button size="icon-sm" variant="ghost" aria-label="Remove partition field" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 />
            </Button>
          </div>
        )
      })}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={cols.length === 0}
          onClick={() => {
            const c = cols[0]
            onChange([...value, { sourceId: c.id, transform: 'identity', name: defaultPartitionName('identity', c.name.replace(/\./g, '_')) }])
          }}
        >
          <Plus /> Add partition field
        </Button>
      </div>
    </div>
  )
}

/** Edits sort order fields. */
export function SortFieldsEditor({ cols, value, onChange }: { cols: SourceColumn[]; value: SortField[]; onChange: (v: SortField[]) => void }) {
  const set = (i: number, patch: Partial<SortField>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)))
  return (
    <div className="flex flex-col gap-1.5">
      {value.length === 0 && <p className="text-[12.5px] text-subtle">Unsorted. Writers keep rows in arrival order.</p>}
      {value.map((f, i) => (
        <div key={i} className="flex flex-wrap items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2 py-1.5">
          <span className="w-5 text-right text-[12px] text-subtle tabular">{i + 1}.</span>
          <select aria-label="Sort column" className={selectCls} value={f['source-id']} onChange={(e) => set(i, { 'source-id': Number(e.target.value) })}>
            {cols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.type})
              </option>
            ))}
          </select>
          <select aria-label="Direction" className={selectCls} value={f.direction} onChange={(e) => set(i, { direction: e.target.value as SortField['direction'] })}>
            <option value="asc">ascending</option>
            <option value="desc">descending</option>
          </select>
          <select aria-label="Null order" className={selectCls} value={f['null-order']} onChange={(e) => set(i, { 'null-order': e.target.value as SortField['null-order'] })}>
            <option value="nulls-first">nulls first</option>
            <option value="nulls-last">nulls last</option>
          </select>
          <div className="flex-1" />
          <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0} onClick={() => { const n = [...value]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; onChange(n) }}>
            <ArrowUp />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === value.length - 1} onClick={() => { const n = [...value]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; onChange(n) }}>
            <ArrowDown />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Remove sort field" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            <Trash2 />
          </Button>
        </div>
      ))}
      <div>
        <Button
          size="sm"
          variant="ghost"
          disabled={cols.length === 0}
          onClick={() => onChange([...value, { transform: 'identity', 'source-id': cols[0].id, direction: 'asc', 'null-order': 'nulls-first' }])}
        >
          <Plus /> Add sort field
        </Button>
      </div>
    </div>
  )
}
