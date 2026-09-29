import { useMemo, useState } from 'react'
import { Plus, RotateCcw, Trash2, Undo2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { cn } from '@/lib/cn'

const MAX = 2048
const byteLen = (s: string) => new TextEncoder().encode(s).length

interface Draft {
  id: number
  key: string
  value: string
  origKey?: string
  removed?: boolean
}

export interface PropertyChanges {
  updates: Record<string, string>
  removals: string[]
}

/** Computes the minimal update/removal set between the original and the draft. */
export function diffProperties(original: Record<string, string>, drafts: Draft[]): PropertyChanges {
  const updates: Record<string, string> = {}
  const removals = new Set<string>()
  for (const d of drafts) {
    if (d.removed) {
      if (d.origKey !== undefined) removals.add(d.origKey)
      continue
    }
    if (d.origKey !== undefined && d.origKey !== d.key) removals.add(d.origKey)
    if (!d.key) continue
    if (original[d.key] !== d.value || d.origKey !== d.key) updates[d.key] = d.value
  }
  for (const k of Object.keys(updates)) removals.delete(k)
  return { updates, removals: [...removals] }
}

export function validateDrafts(drafts: Draft[]): string | null {
  const seen = new Set<string>()
  for (const d of drafts) {
    if (d.removed) continue
    if (!d.key && !d.value) continue
    if (!d.key) return 'Every property needs a key'
    if (byteLen(d.key) > MAX || byteLen(d.value) > MAX) return `Keys and values are limited to ${MAX} bytes`
    if (seen.has(d.key)) return `Duplicate key "${d.key}"`
    seen.add(d.key)
  }
  return null
}

let seq = 0
const toDrafts = (p: Record<string, string>): Draft[] =>
  Object.entries(p)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ id: ++seq, key, value, origKey: key }))

/**
 * Inline key/value editor. Changes are staged locally and committed as one
 * atomic update (updates + removals) with the result reported by the server.
 */
export function PropertiesEditor({
  properties,
  onSave,
  saving,
  error,
  readOnlyKeys = [],
}: {
  properties: Record<string, string>
  onSave: (changes: PropertyChanges) => void
  saving?: boolean
  error?: unknown
  readOnlyKeys?: string[]
}) {
  const [drafts, setDrafts] = useState<Draft[]>(() => toDrafts(properties))
  const [base, setBase] = useState(properties)
  if (base !== properties) {
    setBase(properties)
    setDrafts(toDrafts(properties))
  }
  const changes = useMemo(() => diffProperties(properties, drafts), [properties, drafts])
  const dirty = Object.keys(changes.updates).length > 0 || changes.removals.length > 0
  const invalid = validateDrafts(drafts)
  const update = (id: number, patch: Partial<Draft>) => setDrafts((ds) => ds.map((d) => (d.id === id ? { ...d, ...patch } : d)))

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border">
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_40px] border-b border-border bg-bg-subtle text-[11.5px] font-medium text-muted">
          <div className="px-3 py-2">Key</div>
          <div className="px-3 py-2">Value</div>
          <div />
        </div>
        {drafts.length === 0 && <div className="px-3 py-6 text-center text-[12.5px] text-subtle">No properties</div>}
        {drafts.map((d) => {
          const locked = d.origKey !== undefined && readOnlyKeys.includes(d.origKey)
          const changed = !d.removed && (d.origKey === undefined || d.key !== d.origKey || properties[d.origKey] !== d.value)
          return (
            <div
              key={d.id}
              className={cn(
                'grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_40px] items-center border-b border-border last:border-0',
                d.removed && 'bg-danger-subtle/60',
                changed && 'bg-accent-subtle/40',
              )}
            >
              <div className="px-1.5 py-1">
                <Input
                  aria-label="Property key"
                  value={d.key}
                  disabled={d.removed || locked}
                  onChange={(e) => update(d.id, { key: e.target.value })}
                  className={cn('h-7 border-transparent bg-transparent font-mono text-[12px] hover:border-border', d.removed && 'line-through')}
                  placeholder="key"
                  spellCheck={false}
                />
              </div>
              <div className="px-1.5 py-1">
                <Input
                  aria-label={`Value for ${d.key || 'new property'}`}
                  value={d.value}
                  disabled={d.removed || locked}
                  onChange={(e) => update(d.id, { value: e.target.value })}
                  className={cn('h-7 border-transparent bg-transparent font-mono text-[12px] hover:border-border', d.removed && 'line-through')}
                  placeholder="value"
                  spellCheck={false}
                />
              </div>
              <div className="flex justify-center">
                {!locked &&
                  (d.removed ? (
                    <Button size="icon-sm" variant="ghost" aria-label="Restore property" onClick={() => update(d.id, { removed: false })}>
                      <Undo2 />
                    </Button>
                  ) : (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove ${d.key || 'property'}`}
                      onClick={() => (d.origKey === undefined ? setDrafts((ds) => ds.filter((x) => x.id !== d.id)) : update(d.id, { removed: true }))}
                    >
                      <Trash2 />
                    </Button>
                  ))}
              </div>
            </div>
          )
        })}
      </div>
      {invalid && dirty && <p className="text-[12px] text-danger">{invalid}</p>}
      <InlineError error={error} />
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setDrafts((ds) => [...ds, { id: ++seq, key: '', value: '' }])}>
          <Plus />
          Add property
        </Button>
        <div className="flex-1" />
        {dirty && (
          <>
            <span className="text-[12px] text-muted">
              {Object.keys(changes.updates).length} to set · {changes.removals.length} to remove
            </span>
            <Button size="sm" variant="ghost" onClick={() => setDrafts(toDrafts(properties))}>
              <RotateCcw />
              Discard
            </Button>
          </>
        )}
        <Button size="sm" variant="primary" disabled={!dirty || !!invalid} loading={saving} onClick={() => onSave(changes)}>
          Save changes
        </Button>
      </div>
    </div>
  )
}
