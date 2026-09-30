import { useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, KeyRound, Link2, Plus, Trash2, TriangleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Field, Input, Textarea } from '@/components/ui/input'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState, InlineError } from '@/components/ui/states'
import { Checkbox } from '@/components/ui/switch'
import { TagInput } from '@/components/ui/tag-input'
import { Tooltip } from '@/components/ui/tooltip'
import { listAllNamespaces, listAllTables } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import type { Namespace } from '@/lib/namespace'
import {
  DATATYPES,
  datasetExt,
  fieldExt,
  isTime,
  metricsUsing,
  ossie,
  removeDataset,
  removeField,
  renameDataset,
  renameField,
  sqlOf,
  synonymsOf,
  uniqueName,
  withSql,
  withSynonyms,
  withTime,
  type Datatype,
  type ODataset,
  type OField,
  type OssieModel,
  type Problem,
} from '@/lib/ossie'
import { AIContextEditor } from './AIContextEditor'

const cellInput =
  'h-7 w-full rounded-[var(--radius-control)] border border-transparent bg-transparent px-1.5 text-[12.5px] hover:border-border focus:border-accent focus:outline-none'

/** Names are committed on blur so a rename cascades once, not per keystroke. */
function NameInput({ value, onCommit, label, taken, className }: { value: string; onCommit: (v: string) => void; label: string; taken: string[]; className?: string }) {
  const [text, setText] = useState(value)
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setText(value)
  }
  const clash = text !== value && taken.some((t) => t.toLowerCase() === text.toLowerCase())
  const invalid = !text.trim() || clash
  return (
    <input
      aria-label={label}
      aria-invalid={invalid}
      title={clash ? `${text} is already used` : undefined}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => (invalid ? setText(value) : text !== value && onCommit(text.trim()))}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      spellCheck={false}
      className={cn(cellInput, 'font-mono', invalid && 'border-danger', className)}
    />
  )
}

function FieldRow({
  f,
  ds,
  model,
  onChange,
  onRename,
  onRemove,
  problem,
}: {
  f: OField
  ds: ODataset
  model: OssieModel
  onChange: (f: OField) => void
  onRename: (to: string) => void
  onRemove: () => void
  problem?: string
}) {
  const [open, setOpen] = useState(false)
  const x = fieldExt(f)
  const pk = ds.primary_key?.includes(f.name)
  const usedBy = metricsUsing(model, ds.name, f.name)
  return (
    <>
      <tr className={cn('border-b border-border last:border-0', problem && 'bg-warning-subtle/50')}>
        <td className="w-8 pl-2">
          <button type="button" aria-expanded={open} aria-label={`More about ${f.name}`} className="rounded p-0.5 text-muted hover:bg-surface" onClick={() => setOpen(!open)}>
            {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
          </button>
        </td>
        <td className="px-1 py-1">
          <div className="flex items-center gap-1">
            {pk && (
              <Tooltip content="Primary key">
                <KeyRound className="size-3.5 shrink-0 text-accent-text" aria-label="Primary key" />
              </Tooltip>
            )}
            <NameInput value={f.name} label={`Field name ${f.name}`} taken={(ds.fields ?? []).map((y) => y.name)} onCommit={onRename} />
          </div>
          {problem && <div className="px-1.5 text-[11.5px] text-warning">{problem}</div>}
        </td>
        <td className="px-1 py-1">
          <input aria-label={`Expression of ${f.name}`} value={sqlOf(f.expression)} onChange={(e) => onChange({ ...f, expression: withSql(f.expression, e.target.value) })} spellCheck={false} className={cn(cellInput, 'font-mono')} />
        </td>
        <td className="px-1 py-1">
          <select
            aria-label={`Datatype of ${f.name}`}
            value={f.datatype ?? ''}
            onChange={(e) => onChange({ ...f, datatype: (e.target.value || undefined) as Datatype | undefined })}
            className="h-7 rounded-[var(--radius-control)] border border-border bg-bg px-1 text-[12px]"
          >
            <option value="">—</option>
            {DATATYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
          {x?.icebergType && <div className="px-1 font-mono text-[10.5px] text-subtle">{x.icebergType}</div>}
        </td>
        <td className="px-2 text-center">
          <Checkbox label={`${f.name} is a time dimension`} checked={isTime(f)} onCheckedChange={(v) => onChange(withTime(f, v))} />
        </td>
        <td className="px-1 py-1">
          <input aria-label={`Description of ${f.name}`} value={f.description ?? ''} onChange={(e) => onChange({ ...f, description: e.target.value || undefined })} placeholder="What it means" className={cellInput} />
        </td>
        <td className="whitespace-nowrap px-1 text-right">
          {synonymsOf(f.ai_context).length > 0 && <Badge className="mr-1">{synonymsOf(f.ai_context).length} syn.</Badge>}
          <Tooltip content={usedBy.length ? `Used by ${usedBy.join(', ')}` : 'Remove field'}>
            <Button size="icon-sm" variant="ghost" aria-label={`Remove field ${f.name}`} onClick={onRemove}>
              <Trash2 />
            </Button>
          </Tooltip>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-border bg-bg-subtle">
          <td />
          <td colSpan={6} className="px-2 py-2">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
              <div className="flex flex-col gap-2">
                <Field label="Label" hint="A category, e.g. filter or measure">
                  {(p) => <Input {...p} value={f.label ?? ''} onChange={(e) => onChange({ ...f, label: e.target.value || undefined })} />}
                </Field>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] font-medium">Synonyms</span>
                  <TagInput label={`Synonyms for ${f.name}`} value={synonymsOf(f.ai_context)} onChange={(s) => onChange({ ...f, ai_context: withSynonyms(f.ai_context, s) })} />
                </div>
                {x && <p className="text-[11.5px] text-subtle">Iceberg field ID {x.fieldId}; renames of the column are followed automatically.</p>}
                {usedBy.length > 0 && <p className="text-[11.5px] text-muted">Used by metrics: {usedBy.join(', ')}</p>}
              </div>
              <AIContextEditor subject={f.name} value={f.ai_context} onChange={(v) => onChange({ ...f, ai_context: v })} examples={false} />
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

function KeyPicker({ label, fields, value, onChange }: { label: string; fields: string[]; value: string[]; onChange: (v: string[]) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {fields.map((f) => {
        const on = value.includes(f)
        return (
          <button
            key={f}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== f) : [...value, f])}
            className={cn('h-6 rounded-[4px] border px-1.5 font-mono text-[11.5px]', on ? 'border-accent bg-accent-subtle text-accent-text' : 'border-border text-muted hover:bg-surface')}
          >
            {f}
          </button>
        )
      })}
    </div>
  )
}

export function DatasetEditor({ model, ds, index, setDraft, problems }: { model: OssieModel; ds: ODataset; index: number; setDraft: (f: (m: OssieModel) => OssieModel) => void; problems: Problem[] }) {
  const upd = (f: (d: ODataset) => ODataset) => setDraft((m) => ({ ...m, datasets: m.datasets.map((d, i) => (i === index ? f(d) : d)) }))
  const fields = ds.fields ?? []
  const x = datasetExt(ds)
  const fieldProblem = (k: number) => problems.find((p) => p.path.startsWith(`datasets[${index}].fields[${k}]`))?.message
  const [removing, setRemoving] = useState(false)
  const affected = metricsUsing(model, ds.name)
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Card>
        <CardHeader
          title={
            <span className="flex items-center gap-2">
              <EntityIcon kind="table" /> Dataset
            </span>
          }
          description={x ? `Linked to ${x.warehouse}.${x.namespace.join('.')}.${x.table} (table ${x.tableUuid.slice(0, 8)}…)` : 'Not linked to a catalog table by UUID'}
          actions={
            <Button size="sm" variant="danger-outline" onClick={() => setRemoving(true)}>
              <Trash2 /> Remove dataset
            </Button>
          }
        />
        <div className="grid gap-3 p-4 md:grid-cols-2">
          <Field label="Name" hint="Used in metrics as name.field">
            {(p) => <NameInput {...p} label="Dataset name" value={ds.name} taken={model.datasets.map((d) => d.name)} onCommit={(to) => setDraft((m) => renameDataset(m, ds.name, to))} className="h-8 border-border" />}
          </Field>
          <Field label="Source" hint="How engines address the table (catalog.namespace.table)">
            {(p) => <Input {...p} value={ds.source} onChange={(e) => upd((d) => ({ ...d, source: e.target.value }))} className="font-mono" spellCheck={false} />}
          </Field>
          <div className="md:col-span-2">
            <Field label="Description">{(p) => <Textarea {...p} rows={2} value={ds.description ?? ''} onChange={(e) => upd((d) => ({ ...d, description: e.target.value || undefined }))} />}</Field>
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-[12px] font-medium">Primary key</span>
            <KeyPicker label={`Primary key of ${ds.name}`} fields={fields.map((f) => f.name)} value={ds.primary_key ?? []} onChange={(pk) => upd((d) => ({ ...d, primary_key: pk.length ? pk : undefined }))} />
          </div>
          <div className="flex flex-col gap-1.5 md:col-span-2">
            <span className="text-[12px] font-medium">Unique keys</span>
            {(ds.unique_keys ?? []).map((uk, k) => (
              <div key={k} className="flex items-center gap-2">
                <KeyPicker label={`Unique key ${k + 1} of ${ds.name}`} fields={fields.map((f) => f.name)} value={uk} onChange={(cols) => upd((d) => ({ ...d, unique_keys: d.unique_keys!.map((u, j) => (j === k ? cols : u)) }))} />
                <Button size="icon-sm" variant="ghost" aria-label={`Remove unique key ${k + 1}`} onClick={() => upd((d) => ({ ...d, unique_keys: d.unique_keys!.filter((_, j) => j !== k) }))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div>
              <Button size="sm" variant="ghost" onClick={() => upd((d) => ({ ...d, unique_keys: [...(d.unique_keys ?? []), []] }))}>
                <Plus /> Add unique key
              </Button>
            </div>
          </div>
          <div className="md:col-span-2">
            <AIContextEditor subject={ds.name} value={ds.ai_context} onChange={(v) => upd((d) => ({ ...d, ai_context: v }))} />
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title={`Fields (${fields.length})`} description="Row-level attributes. Simple expressions read a column; any SQL expression defines a derived field." />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-[13px]">
            <thead className="bg-bg-subtle">
              <tr className="border-b border-border text-left text-[11.5px] font-medium text-muted">
                <th className="w-8" />
                <th className="h-8 px-2">Field</th>
                <th className="px-2">Expression (ANSI SQL)</th>
                <th className="px-2">Datatype</th>
                <th className="px-2 text-center">Time</th>
                <th className="px-2">Description</th>
                <th className="w-20" />
              </tr>
            </thead>
            <tbody>
              {fields.map((f, k) => (
                <FieldRow
                  key={`${k}`}
                  f={f}
                  ds={ds}
                  model={model}
                  problem={fieldProblem(k)}
                  onChange={(nf) => upd((d) => ({ ...d, fields: d.fields!.map((y, j) => (j === k ? nf : y)) }))}
                  onRename={(to) => setDraft((m) => renameField(m, ds.name, f.name, to))}
                  onRemove={() => setDraft((m) => removeField(m, ds.name, f.name))}
                />
              ))}
            </tbody>
          </table>
        </div>
        <div className="border-t border-border px-2 py-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const name = uniqueName('derived_field', fields.map((f) => f.name))
              upd((d) => ({ ...d, fields: [...(d.fields ?? []), { name, expression: withSql(undefined, '') }] }))
            }}
          >
            <Plus /> Add derived field
          </Button>
        </div>
      </Card>

      <Dialog open={removing} onOpenChange={setRemoving}>
        <DialogContent title={`Remove ${ds.name}?`} description="The dataset and the relationships that use it are removed from the draft. Nothing changes in the catalog.">
          <DialogBody>
            {affected.length > 0 && (
              <p className="flex items-start gap-2 rounded-[var(--radius-control)] bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> Metrics that reference it must be edited before saving: {affected.join(', ')}.
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRemoving(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setRemoving(false)
                setDraft((m) => removeDataset(m, ds.name))
              }}
            >
              Remove dataset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** Namespaces of a warehouse, breadth-first (bounded). */
async function allNamespaces(cluster: string, wh: string, limit = 200): Promise<Namespace[]> {
  const out: Namespace[] = []
  const queue: Namespace[] = [[]]
  while (queue.length && out.length < limit) {
    const parent = queue.shift()!
    const kids = await listAllNamespaces(cluster, wh, parent.length ? parent : undefined)
    for (const k of kids) {
      out.push(k)
      queue.push(k)
    }
  }
  return out
}

function AddTablesDialog({ cluster, wh, ns, model, open, onOpenChange, onAdd }: { cluster: string; wh: string; ns: Namespace; model: OssieModel; open: boolean; onOpenChange: (v: boolean) => void; onAdd: (d: ODataset[]) => void }) {
  const [pickNs, setPickNs] = useState(ns.join('\u001f'))
  const [picked, setPicked] = useState<string[]>([])
  const nss = useQuery({ queryKey: ['semantic-ns', cluster, wh], queryFn: () => allNamespaces(cluster, wh), enabled: open })
  const current = pickNs.split('\u001f')
  const tables = useQuery({ queryKey: ['semantic-tables', cluster, wh, pickNs], queryFn: () => listAllTables(cluster, wh, current), enabled: open })
  const linked = new Set(model.datasets.map((d) => datasetExt(d)).filter(Boolean).map((x) => `${x!.namespace.join('\u001f')}/${x!.table}`))
  const gen = useMutation({
    mutationFn: () =>
      ossie.generate(
        cluster,
        wh,
        picked.map((t) => ({ namespace: current, name: t })),
        model.datasets.map((d) => d.name),
      ),
    onSuccess: (ds) => {
      onAdd(ds)
      setPicked([])
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add tables" description="Each table becomes a dataset with its columns, types, docs and row key." wide>
        <DialogBody>
          <Field label="Namespace">
            {(p) => (
              <select
                {...p}
                value={pickNs}
                onChange={(e) => {
                  setPickNs(e.target.value)
                  setPicked([])
                }}
                className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]"
              >
                {(nss.data ?? [ns]).map((n) => (
                  <option key={n.join('\u001f')} value={n.join('\u001f')}>
                    {wh}.{n.join('.')}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <div className="grid max-h-60 grid-cols-2 gap-1 overflow-y-auto">
            {tables.isPending && <p className="text-[12.5px] text-muted">Loading tables…</p>}
            {tables.isError && <InlineError error={tables.error} />}
            {tables.data?.map((t) => {
              const already = linked.has(`${pickNs}/${t.name}`)
              return (
                <label key={t.name} className={cn('flex items-center gap-2 rounded px-1.5 py-1', already ? 'opacity-50' : 'cursor-pointer hover:bg-surface')}>
                  <Checkbox label={`Add ${t.name}`} disabled={already} checked={picked.includes(t.name)} onCheckedChange={(v) => setPicked(v ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />
                  <span className="truncate font-mono text-[12.5px]">{t.name}</span>
                  {already && <Badge>in model</Badge>}
                </label>
              )
            })}
          </div>
          <InlineError error={gen.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!picked.length} loading={gen.isPending} onClick={() => gen.mutate()}>
            Add {picked.length || ''} dataset{picked.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function DatasetsPanel({
  cluster,
  wh,
  ns,
  model,
  setDraft,
  problems,
  selected,
  onSelect,
}: {
  cluster: string
  wh: string
  ns: Namespace
  model: OssieModel
  setDraft: (f: (m: OssieModel) => OssieModel) => void
  problems: Problem[]
  selected: number
  onSelect: (i: number) => void
}) {
  const [adding, setAdding] = useState(false)
  const idx = Math.min(selected, model.datasets.length - 1)
  const ds = model.datasets[idx]
  const counts = useMemo(() => model.datasets.map((_, i) => problems.filter((p) => p.path.startsWith(`datasets[${i}]`)).length), [model.datasets, problems])
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <Card className="self-start">
        <CardHeader
          title={`Datasets (${model.datasets.length})`}
          actions={
            <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
              <Plus /> Add tables
            </Button>
          }
        />
        <ul className="p-1.5" aria-label="Datasets">
          {model.datasets.map((d, i) => (
            <li key={`${d.name}-${i}`}>
              <button
                type="button"
                aria-current={i === idx}
                onClick={() => onSelect(i)}
                className={cn('flex w-full items-center gap-2 rounded-[5px] px-2 py-1.5 text-left', i === idx ? 'bg-surface' : 'hover:bg-surface')}
              >
                <EntityIcon kind="table" className="size-3.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-[12.5px] font-medium">{d.name}</span>
                  <span className="block truncate font-mono text-[11px] text-subtle">{d.source}</span>
                </span>
                {!datasetExt(d) && (
                  <Tooltip content="Not linked to a table by UUID">
                    <Link2 className="size-3.5 text-subtle" aria-label="Not linked" />
                  </Tooltip>
                )}
                {counts[i] > 0 && <Badge tone="warning">{counts[i]}</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      {ds ? (
        <DatasetEditor key={idx} model={model} ds={ds} index={idx} setDraft={setDraft} problems={problems} />
      ) : (
        <EmptyState title="No datasets" action={<Button onClick={() => setAdding(true)}><Plus /> Add tables</Button>}>
          An Ossie model needs at least one dataset.
        </EmptyState>
      )}
      <AddTablesDialog
        cluster={cluster}
        wh={wh}
        ns={ns}
        model={model}
        open={adding}
        onOpenChange={setAdding}
        onAdd={(added) => {
          setDraft((m) => ({ ...m, datasets: [...m.datasets, ...added] }))
          onSelect(model.datasets.length)
        }}
      />
    </div>
  )
}
