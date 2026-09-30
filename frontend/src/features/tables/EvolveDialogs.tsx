import { useEffect, useMemo, useState } from 'react'
import { ArrowUpCircle, GitBranch, History, KeyRound, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Label } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { cn } from '@/lib/cn'
import {
  assignPartitionFieldIds,
  createRefChange,
  REF_NAME_RE,
  removeRefChange,
  removeSnapshotsChange,
  rollbackChange,
  schemaChange,
  sortChange,
  specChange,
  updateRefChange,
  upgradeFormatChange,
  type RefRetention,
  type SpecFieldDraft,
  type TableChange,
} from '@/lib/commits'
import { formatDateTime, formatNumber } from '@/lib/format'
import {
  currentSchema,
  diffSchemas,
  fieldNames,
  summaryNumber,
  typeLabel,
  type FieldChange,
  type SortField,
  type TableIdentifier,
  type TableMetadata,
} from '@/lib/iceberg'
import type { Int64 } from '@/lib/json'
import { droppedIds, fieldFromIceberg, identifierCandidates, toIcebergFields, validateFields } from '@/lib/schemaModel'
import { CommitBar, type TableCommit } from './CommitBar'
import { PartitionFieldsEditor, partitionProblems, SortFieldsEditor, sourceColumns } from './LayoutEditors'
import { SchemaEditor, withoutDropped, type DraftField } from './SchemaEditor'

interface Base {
  md: TableMetadata
  id: TableIdentifier
  commit: TableCommit
  open: boolean
  onOpenChange: (v: boolean) => void
}

function describeChange(c: FieldChange): string {
  switch (c.kind) {
    case 'added':
      return `Add ${c.field.path.join('.')} (${typeLabel(c.field.type)})`
    case 'removed':
      return `Drop ${c.field.path.join('.')}`
    case 'renamed':
      return `Rename ${c.from.path.join('.')} → ${c.to.path.join('.')}`
    case 'type':
      return `Widen ${c.to.path.join('.')}: ${typeLabel(c.from.type)} → ${typeLabel(c.to.type)}`
    case 'nullability':
      return `Make ${c.to.path.join('.')} optional`
    case 'doc':
      return `Document ${c.to.path.join('.')}`
  }
}

// ---------------------------------------------------------------- schema

export function EvolveSchemaDialog({ md, id, commit, open, onOpenChange }: Base) {
  const cur = currentSchema(md)!
  const [fields, setFields] = useState<DraftField[]>(() => cur.fields.map(fieldFromIceberg))
  const curIdents = useMemo(() => cur['identifier-field-ids'] ?? [], [cur])
  const [idents, setIdents] = useState<number[]>(curIdents)
  useEffect(() => {
    if (open) {
      setFields(cur.fields.map(fieldFromIceberg))
      setIdents(curIdents)
      commit.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cur])

  const kept = useMemo(() => withoutDropped(fields), [fields])
  const problems = validateFields(kept, { evolution: true, formatVersion: md['format-version'] })
  const built = useMemo(() => toIcebergFields(kept, md['last-column-id'] + 1), [kept, md])
  const changes = useMemo(() => diffSchemas(cur, { type: 'struct', fields: built.fields }), [cur, built])
  // Only existing columns can be "reordered"; new ones are additions.
  const candidates = useMemo(() => identifierCandidates(built.fields), [built])
  const identsChanged = [...idents].sort().join(',') !== [...curIdents].sort().join(',')
  const identProblems = idents
    .filter((i) => !candidates.some((c) => c.id === i) && !droppedIds(cur, kept).includes(i))
    .map((i) => `${fieldNames(cur).get(i) ?? i} is part of the row key, so it must stay a required primitive (not float or double); remove it from the row key first`)
  const orderChanged =
    kept.filter((f) => f.id != null).map((f) => f.id).join(',') !== cur.fields.map((f) => f.id).filter((i) => kept.some((k) => k.id === i)).join(',')

  // Columns still referenced by the table layout cannot be dropped.
  const dropped = droppedIds(cur, kept)
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  const names = fieldNames(cur)
  const blocked = dropped.flatMap((fid) => {
    const why = [
      spec?.fields.some((f) => f['source-id'] === fid) && 'the current partition spec',
      order?.fields.some((f) => f['source-id'] === fid) && 'the current sort order',
      idents.includes(fid) && 'the row key (identifier fields)',
    ].filter(Boolean)
    return why.length ? [`${names.get(fid)} is used by ${why.join(' and ')}; change that first`] : []
  })
  const all = [...problems.map((p) => p.message), ...blocked, ...identProblems]
  const nothing = changes.length === 0 && !orderChanged && !identsChanged
  const pathOf = (i: number) => candidates.find((c) => c.id === i)?.path ?? fieldNames(cur).get(i) ?? String(i)
  const identSummary = `Row key: ${idents.length ? idents.map(pathOf).join(', ') : 'none'}`

  const build = (): TableChange | null => {
    if (all.length || nothing) return null
    const parts = [...changes.map(describeChange), ...(orderChanged ? ['Reorder columns'] : []), ...(identsChanged ? [identSummary] : [])]
    return schemaChange(md, id, built.fields, built.lastId, `Schema: ${parts.join('; ')}`, idents)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Evolve schema" description="Iceberg evolves schemas in place: renames and drops never rewrite data, and column ids keep history intact." className="max-w-5xl" wide>
        <DialogBody className="max-h-[68vh]">
          <SchemaEditor fields={fields} onChange={setFields} problems={problems} evolution formatVersion={md['format-version']} />
          <fieldset className="rounded-[var(--radius-card)] border border-border px-3 py-2.5">
            <legend className="flex items-center gap-1.5 px-1 text-[12px] font-medium">
              <KeyRound className="size-3.5" /> Row key (identifier fields)
            </legend>
            <p className="mb-2 text-[12px] text-muted">Columns that identify a row, used by engines for upserts and equality deletes. Only required primitive columns (not float or double) outside lists and maps qualify.</p>
            {candidates.length === 0 ? (
              <p className="text-[12.5px] text-subtle">No column qualifies. Mark an existing primitive column as required to use it here.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {candidates.map((c) => {
                  const on = idents.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setIdents(on ? idents.filter((x) => x !== c.id) : [...idents, c.id])}
                      className={cn(
                        'inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] border px-2 font-mono text-[12px]',
                        on ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-muted hover:bg-surface',
                      )}
                    >
                      {on && <KeyRound className="size-3" />}
                      {c.path}
                    </button>
                  )
                })}
              </div>
            )}
          </fieldset>
          <div className="rounded-[var(--radius-card)] border border-border bg-bg-subtle px-3 py-2.5">
            <div className="mb-1 text-[12px] font-medium">
              Pending changes → schema {Math.max(...md.schemas.map((s) => s['schema-id'])) + 1}
            </div>
            {nothing ? (
              <p className="text-[12.5px] text-subtle">No changes yet. Rename, widen, document, reorder, add or drop columns above.</p>
            ) : (
              <ul className="flex flex-col gap-0.5 text-[12.5px]">
                {changes.map((c, i) => (
                  <li key={i} className="font-mono text-[12px]">
                    {describeChange(c)}
                  </li>
                ))}
                {orderChanged && <li className="font-mono text-[12px]">Reorder columns</li>}
                {identsChanged && <li className="font-mono text-[12px]">{identSummary}</li>}
              </ul>
            )}
          </div>
          {[...blocked, ...identProblems].map((b) => (
            <InlineError key={b} error={new Error(b)} />
          ))}
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={build} disabled={all.length > 0 || nothing} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel="Apply schema change" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- partitioning

export function EvolvePartitionDialog({ md, id, commit, open, onOpenChange }: Base) {
  const cur = currentSchema(md)!
  const cols = useMemo(() => sourceColumns(cur), [cur])
  const spec = md['partition-specs'].find((s) => s['spec-id'] === md['default-spec-id'])
  const initial = useMemo<SpecFieldDraft[]>(() => (spec?.fields ?? []).map((f) => ({ sourceId: f['source-id'], transform: f.transform, name: f.name, fieldId: f['field-id'] })), [spec])
  const [drafts, setDrafts] = useState<SpecFieldDraft[]>(initial)
  useEffect(() => {
    if (open) {
      setDrafts(initial)
      commit.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])
  const v1 = md['format-version'] < 2
  // Format v1 cannot drop partition fields: removed fields become void transforms.
  const effective = useMemo(() => {
    if (!v1) return drafts
    const kept = new Set<number | undefined>(drafts.map((d) => d.fieldId).filter((x) => x != null))
    const voided = initial.filter((f) => !kept.has(f.fieldId)).map((f) => ({ ...f, transform: 'void', fieldId: undefined }))
    return [...drafts, ...voided]
  }, [drafts, initial, v1])
  const problems = partitionProblems(effective, cols)
  const fields = assignPartitionFieldIds(md, effective)
  const same = JSON.stringify(fields.map((f) => [f['source-id'], f.transform, f.name])) === JSON.stringify((spec?.fields ?? []).map((f) => [f['source-id'], f.transform, f.name]))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Evolve partitioning" description="Existing files keep their old layout; new writes use the new spec. Queries work across both." wide>
        <DialogBody>
          <PartitionFieldsEditor cols={cols} value={drafts} onChange={setDrafts} />
          {v1 && <p className="text-[12px] text-muted">This is a format v1 table: removed fields are kept as <span className="font-mono">void</span> transforms.</p>}
          {problems.length > 0 && <InlineError error={new Error(problems[0])} />}
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => (problems.length || same ? null : specChange(md, id, fields))} disabled={problems.length > 0 || same} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel="Apply new spec" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function EvolveSortDialog({ md, id, commit, open, onOpenChange }: Base) {
  const cols = useMemo(() => sourceColumns(currentSchema(md)!), [md])
  const order = md['sort-orders']?.find((o) => o['order-id'] === md['default-sort-order-id'])
  const [fields, setFields] = useState<SortField[]>(order?.fields ?? [])
  useEffect(() => {
    if (open) {
      setFields(order?.fields ?? [])
      commit.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order])
  const same = JSON.stringify(fields) === JSON.stringify(order?.fields ?? [])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Change sort order" description="Applies to data written from now on; existing files are not rewritten." wide>
        <DialogBody>
          <SortFieldsEditor cols={cols} value={fields} onChange={setFields} />
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => (same ? null : sortChange(md, id, fields))} disabled={same} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel="Apply sort order" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- snapshots & refs

export function RollbackDialog({ md, id, commit, open, onOpenChange, snapshotId }: Base & { snapshotId: Int64 | null }) {
  const target = md.snapshots?.find((s) => s['snapshot-id'] === snapshotId)
  const current = md.snapshots?.find((s) => s['snapshot-id'] === md['current-snapshot-id'])
  useEffect(() => {
    if (open) commit.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!target) return null
  const rows = [
    ['Committed', formatDateTime(current?.['timestamp-ms']), formatDateTime(target['timestamp-ms'])],
    ['Records', formatNumber(summaryNumber(current, 'total-records')), formatNumber(summaryNumber(target, 'total-records'))],
    ['Data files', formatNumber(summaryNumber(current, 'total-data-files')), formatNumber(summaryNumber(target, 'total-data-files'))],
  ]
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Roll back table" description="Points the main branch at an earlier snapshot. Later snapshots stay available until they expire." wide>
        <DialogBody>
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-subtle">
                <th className="pb-1 font-medium" />
                <th className="pb-1 font-medium">Current main</th>
                <th className="pb-1 font-medium">After rollback</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="py-1 text-muted">Snapshot</td>
                <td className="py-1 font-mono text-[12px]">{String(md['current-snapshot-id'])}</td>
                <td className="py-1 font-mono text-[12px] font-semibold">{String(target['snapshot-id'])}</td>
              </tr>
              {rows.map(([l, a, b]) => (
                <tr key={l}>
                  <td className="py-1 text-muted">{l}</td>
                  <td className="py-1 tabular">{a}</td>
                  <td className="py-1 font-semibold tabular">{b}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
            <History className="mt-0.5 size-4 shrink-0" />
            Readers see the older data immediately. If writers committed after you opened this page, the rollback is rejected rather than discarding their work.
          </p>
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => rollbackChange(md, id, target['snapshot-id'])} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel="Roll back main" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ExpireSnapshotsDialog({ md, id, commit, open, onOpenChange, snapshotIds }: Base & { snapshotIds: Int64[] }) {
  useEffect(() => {
    if (open) commit.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const chosen = (md.snapshots ?? []).filter((s) => snapshotIds.includes(s['snapshot-id'])).sort((a, b) => a['timestamp-ms'] - b['timestamp-ms'])
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Expire ${chosen.length} snapshot${chosen.length === 1 ? '' : 's'}`} description="Removes the snapshots from the table history (remove-snapshots)." wide>
        <DialogBody>
          <ul className="max-h-60 overflow-y-auto rounded-[var(--radius-control)] border border-border text-[12.5px]">
            {chosen.map((s) => (
              <li key={String(s['snapshot-id'])} className="flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-0">
                <span className="font-mono text-[12px]">{String(s['snapshot-id'])}</span>
                <Badge>{s.summary?.operation ?? 'unknown'}</Badge>
                <span className="ml-auto text-muted">{formatDateTime(s['timestamp-ms'])}</span>
              </li>
            ))}
          </ul>
          <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
            <History className="mt-0.5 size-4 shrink-0" />
            You can no longer read, roll back to or tag these snapshots. Files that only they reference become unreferenced and are reclaimed by table maintenance. This cannot be undone.
          </p>
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => removeSnapshotsChange(md, id, chosen.map((s) => s['snapshot-id']))} disabled={chosen.length === 0} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel="Expire snapshots" />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

function RetentionFields({ type, value, onChange }: { type: 'branch' | 'tag'; value: RefRetention; onChange: (v: RefRetention) => void }) {
  const num = (k: keyof RefRetention, scale: number) => ({
    value: value[k] != null ? String(Math.round((value[k] as number) / scale)) : '',
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = e.target.value === '' ? undefined : Math.max(1, Math.round(Number(e.target.value))) * scale
      onChange({ ...value, [k]: n })
    },
  })
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Expire reference after (days)" hint="Leave empty to keep it forever.">
        {(p) => <Input {...p} type="number" min={1} placeholder="never" {...num('max-ref-age-ms', DAY)} />}
      </Field>
      {type === 'branch' && (
        <>
          <Field label="Minimum snapshots to keep">{(p) => <Input {...p} type="number" min={1} placeholder="table default" {...num('min-snapshots-to-keep', 1)} />}</Field>
          <Field label="Maximum snapshot age (hours)">{(p) => <Input {...p} type="number" min={1} placeholder="table default" {...num('max-snapshot-age-ms', HOUR)} />}</Field>
        </>
      )}
    </div>
  )
}

export function RefDialog({ md, id, commit, open, onOpenChange, snapshotId, editName }: Base & { snapshotId?: Int64 | null; editName?: string | null }) {
  const existing = editName ? md.refs?.[editName] : undefined
  const [name, setName] = useState('')
  const [type, setType] = useState<'branch' | 'tag'>('tag')
  const [ret, setRet] = useState<RefRetention>({})
  useEffect(() => {
    if (!open) return
    commit.reset()
    setName(editName ?? '')
    setType(existing?.type ?? 'tag')
    setRet({ 'min-snapshots-to-keep': existing?.['min-snapshots-to-keep'], 'max-snapshot-age-ms': existing?.['max-snapshot-age-ms'], 'max-ref-age-ms': existing?.['max-ref-age-ms'] })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editName])
  const target = existing?.['snapshot-id'] ?? snapshotId
  const nameErr = !existing && name ? (!REF_NAME_RE.test(name) ? 'Use letters, digits, dot, dash and underscore' : md.refs?.[name] ? `"${name}" already exists` : null) : null
  const ok = !!target && (existing || (name && !nameErr))
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={existing ? `Edit ${existing.type} ${editName}` : 'Create branch or tag'}
        description={<>At snapshot <span className="font-mono">{String(target ?? '')}</span></>}
        wide
      >
        <DialogBody>
          {!existing && (
            <>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Reference type">
                {(['tag', 'branch'] as const).map((t) => (
                  <label key={t} className={cn('flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] border p-3 text-[12.5px]', type === t ? 'border-accent bg-accent-subtle/40' : 'border-border')}>
                    <input type="radio" name="ref-type" checked={type === t} onChange={() => setType(t)} className="mt-0.5 accent-[var(--accent)]" />
                    <span>
                      <span className="flex items-center gap-1.5 font-medium">
                        {t === 'tag' ? <Tag className="size-3.5" /> : <GitBranch className="size-3.5" />}
                        {t === 'tag' ? 'Tag' : 'Branch'}
                      </span>
                      <span className="text-muted">{t === 'tag' ? 'A fixed, named snapshot (e.g. month-end).' : 'An independent line of commits (e.g. audit, WAP).'}</span>
                    </span>
                  </label>
                ))}
              </div>
              <Field label="Name" error={nameErr}>
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus placeholder={type === 'tag' ? 'eom-2026-09' : 'audit'} />}
              </Field>
            </>
          )}
          <div className="flex flex-col gap-1.5">
            <Label>Retention</Label>
            <RetentionFields type={existing?.type ?? type} value={ret} onChange={setRet} />
          </div>
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar
            commit={commit}
            disabled={!ok}
            build={() => (!ok ? null : existing ? updateRefChange(md, id, editName!, ret) : createRefChange(md, id, name, type, target!, ret))}
            onDone={() => onOpenChange(false)}
            onCancel={() => onOpenChange(false)}
            applyLabel={existing ? 'Save' : `Create ${type}`}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveRefDialog({ md, id, commit, open, onOpenChange, name }: Base & { name: string | null }) {
  const ref = name ? md.refs?.[name] : undefined
  useEffect(() => {
    if (open) commit.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  if (!name || !ref) return null
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Remove ${ref.type} ${name}`}>
        <DialogBody>
          <p className="text-[13px]">
            The reference is removed; snapshots it kept alive may then be expired by maintenance. Table data on <Badge tone="accent" mono>main</Badge> is not affected.
          </p>
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => removeRefChange(md, id, name)} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel={`Remove ${ref.type}`} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function UpgradeFormatDialog({ md, id, commit, open, onOpenChange }: Base) {
  useEffect(() => {
    if (open) commit.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  const next = md['format-version'] + 1
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Upgrade to Iceberg v${next}`}>
        <DialogBody>
          <p className="flex items-start gap-2 text-[13px]">
            <ArrowUpCircle className="mt-0.5 size-4 shrink-0 text-accent" />
            <span>
              Upgrading enables v{next} features{next === 3 ? ' (row lineage, deletion vectors, new types)' : ' (row-level deletes)'}. It cannot be undone, and engines that only support v{md['format-version']} will no longer be able to write this table.
            </span>
          </p>
        </DialogBody>
        <DialogFooter className="block">
          <CommitBar commit={commit} build={() => upgradeFormatChange(md, id, next)} onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} applyLabel={`Upgrade to v${next}`} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
