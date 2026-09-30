import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { FileInput, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Label, Textarea } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { Checkbox } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { commitView, createView, registerTable, registerView } from '@/lib/catalog'
import type { LoadViewResult, ViewMetadata } from '@/lib/iceberg'
import { currentViewVersion } from '@/lib/iceberg'
import { namespaceLabel, validateLevel, type Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { fieldFromIceberg, newField, toIcebergFields, validateFields } from '@/lib/schemaModel'
import { paths } from '@/layout/paths'
import { invalidateCluster } from '@/features/warehouses/WarehouseDialogs'
import { SchemaEditor, type DraftField } from '@/features/tables/SchemaEditor'

const NAME_RE = /^[a-z0-9_]{1,250}$/
const ENGINE = { 'engine-name': 'aistor-catalog-ui' }
const DIALECTS = ['spark', 'trino', 'hive', 'flink', 'dremio', 'duckdb']

// ---------------------------------------------------------------- register

export function RegisterDialog({ kind, cluster, wh, ns }: { kind: 'table' | 'view'; cluster: string; wh: string; ns: Namespace }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [loc, setLoc] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const m = useMutation({
    mutationFn: async (): Promise<unknown> => (kind === 'table' ? registerTable(cluster, wh, ns, name, loc, overwrite) : registerView(cluster, wh, ns, name, loc)),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success(`${kind === 'table' ? 'Table' : 'View'} registered`, name)
      setOpen(false)
      navigate(kind === 'table' ? paths.table(cluster, wh, ns, name) : paths.view(cluster, wh, ns, name))
    },
  })
  const nameErr = name ? validateLevel(name) : null
  const locErr = loc && !/^s3:\/\/.+\.metadata\.json$/.test(loc) ? 'Must be an s3:// URI of a *.metadata.json file' : loc && !loc.startsWith(`s3://${wh}/`) ? `Usually inside the warehouse bucket (s3://${wh}/…)` : null
  const blocking = !name || !loc || !!nameErr || (!!locErr && !loc.startsWith('s3://'))
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { setName(''); setLoc(''); setOverwrite(false); m.reset() } }}>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <FileInput /> Register {kind}
      </Button>
      <DialogContent title={`Register existing ${kind}`} description={`Adds a catalog entry for Iceberg ${kind} metadata that already exists in storage.`}>
        <form onSubmit={(e) => { e.preventDefault(); if (!blocking) m.mutate() }}>
          <DialogBody>
            <Field label="Name" error={nameErr}>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus />}
            </Field>
            <Field label="Metadata location" error={locErr && !loc.startsWith('s3://') ? locErr : null} hint={locErr && loc.startsWith('s3://') ? locErr : 'Full path of the current metadata JSON file.'}>
              {(p) => <Input {...p} value={loc} onChange={(e) => setLoc(e.target.value.trim())} className="font-mono text-[12px]" placeholder={`s3://${wh}/…/metadata/00003.metadata.json`} />}
            </Field>
            {kind === 'table' && (
              <label className="flex items-start gap-2 text-[12.5px]">
                <Checkbox checked={overwrite} onCheckedChange={setOverwrite} className="mt-0.5" />
                <span>
                  <span className="font-medium">Overwrite an existing entry</span>
                  <span className="block text-muted">Points an existing table name at this metadata file.</span>
                </span>
              </label>
            )}
            <p className="text-[12px] text-muted">Registration fails if the table's data files were purged.</p>
            <InlineError error={m.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={blocking} loading={m.isPending}>Register</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- SQL representations editor

interface Rep {
  dialect: string
  sql: string
}

function RepsEditor({ reps, onChange }: { reps: Rep[]; onChange: (r: Rep[]) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {reps.map((r, i) => (
        <div key={i} className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-border p-3">
          <div className="flex items-center gap-2">
            <Label htmlFor={`dialect-${i}`}>Dialect</Label>
            <input
              id={`dialect-${i}`}
              list="sql-dialects"
              value={r.dialect}
              onChange={(e) => onChange(reps.map((x, j) => (j === i ? { ...x, dialect: e.target.value.trim().toLowerCase() } : x)))}
              className="h-7 w-32 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12px]"
            />
            <div className="flex-1" />
            {reps.length > 1 && (
              <Button size="icon-sm" variant="ghost" aria-label={`Remove ${r.dialect} SQL`} onClick={() => onChange(reps.filter((_, j) => j !== i))}>
                <Trash2 />
              </Button>
            )}
          </div>
          <Textarea
            aria-label={`SQL (${r.dialect})`}
            value={r.sql}
            onChange={(e) => onChange(reps.map((x, j) => (j === i ? { ...x, sql: e.target.value } : x)))}
            spellCheck={false}
            className="min-h-40 font-mono text-[12.5px] leading-6"
            placeholder="SELECT …"
          />
        </div>
      ))}
      <datalist id="sql-dialects">
        {DIALECTS.map((d) => (
          <option key={d} value={d} />
        ))}
      </datalist>
      <div>
        <Button size="sm" variant="ghost" onClick={() => onChange([...reps, { dialect: DIALECTS.find((d) => !reps.some((r) => r.dialect === d)) ?? 'spark', sql: reps[0]?.sql ?? '' }])}>
          <Plus /> Add dialect
        </Button>
      </div>
    </div>
  )
}

function repProblems(reps: Rep[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const r of reps) {
    if (!r.dialect) out.push('Every SQL representation needs a dialect')
    if (seen.has(r.dialect)) out.push(`Dialect "${r.dialect}" appears twice`)
    seen.add(r.dialect)
    if (!r.sql.trim()) out.push(`SQL for ${r.dialect || 'a dialect'} is empty`)
  }
  return out
}

// ---------------------------------------------------------------- create view

export function CreateViewDialog({ cluster, wh, ns }: { cluster: string; wh: string; ns: Namespace }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [comment, setComment] = useState('')
  const [reps, setReps] = useState<Rep[]>([{ dialect: 'spark', sql: '' }])
  const [fields, setFields] = useState<DraftField[]>(() => [newField('col_1')])
  const [touched, setTouched] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const problems = [
    ...(name ? (NAME_RE.test(name) ? [] : ['View name: use 1–250 lowercase letters, digits and underscores']) : ['View name is required']),
    ...repProblems(reps),
    ...validateFields(fields).map((p) => p.message),
  ]
  const m = useMutation({
    mutationFn: () =>
      createView(cluster, wh, ns, {
        name,
        schema: { type: 'struct', 'schema-id': 0, fields: toIcebergFields(fields, 1).fields },
        'view-version': {
          'version-id': 1,
          'timestamp-ms': Date.now(),
          'schema-id': 0,
          summary: ENGINE,
          representations: reps.map((r) => ({ type: 'sql', sql: r.sql.trim(), dialect: r.dialect })),
          'default-namespace': ns,
        },
        properties: comment ? { comment } : {},
      }),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('View created', name)
      setOpen(false)
      navigate(paths.view(cluster, wh, ns, name))
    },
  })
  return (
    <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) { m.reset(); setTouched(false) } }}>
      <Button size="sm" variant="primary" onClick={() => setOpen(true)}>
        <Plus /> New view
      </Button>
      <DialogContent title="Create view" description={<>In <span className="font-mono">{wh}.{namespaceLabel(ns)}</span>. Unqualified table names resolve in this namespace.</>} className="max-w-4xl" wide>
        <DialogBody className="max-h-[70vh]">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" autoFocus />}</Field>
            <Field label="Comment">{(p) => <Input {...p} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What this view is for" />}</Field>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>SQL definition</Label>
            <RepsEditor reps={reps} onChange={setReps} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label>Output columns</Label>
            <p className="text-[12px] text-muted">The schema the query produces, in order. Engines validate it when the view is used.</p>
            <SchemaEditor fields={fields} onChange={setFields} problems={touched ? validateFields(fields) : []} />
          </div>
          {touched && problems.length > 0 && <InlineError error={new Error(problems[0])} />}
          <InlineError error={m.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="primary" loading={m.isPending} onClick={() => { setTouched(true); if (problems.length === 0) m.mutate() }}>Create view</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------- new version of a view

/** Publishes a new view version (optionally with a new schema) and makes it current. */
export function EditViewDialog({ cluster, wh, ns, view, md, open, onOpenChange }: { cluster: string; wh: string; ns: Namespace; view: string; md: ViewMetadata; open: boolean; onOpenChange: (v: boolean) => void }) {
  const cur = currentViewVersion(md)
  const curSchema = md.schemas.find((s) => s['schema-id'] === cur?.['schema-id']) ?? md.schemas[md.schemas.length - 1]
  const initialReps = useMemo(() => (cur?.representations ?? []).filter((r) => r.type === 'sql').map((r) => ({ dialect: r.dialect, sql: r.sql })), [cur])
  const [reps, setReps] = useState<Rep[]>(initialReps)
  const [fields, setFields] = useState<DraftField[]>(() => curSchema.fields.map(fieldFromIceberg))
  const [touched, setTouched] = useState(false)
  useEffect(() => {
    if (open) {
      setReps(initialReps)
      setFields(curSchema.fields.map(fieldFromIceberg))
      setTouched(false)
    }
  }, [open, initialReps, curSchema])
  const qc = useQueryClient()
  const toast = useToast()
  const built = toIcebergFields(fields, 1).fields
  const schemaChanged = JSON.stringify(built) !== JSON.stringify(toIcebergFields(curSchema.fields.map(fieldFromIceberg), 1).fields)
  const sqlChanged = JSON.stringify(reps) !== JSON.stringify(initialReps)
  const problems = [...repProblems(reps), ...validateFields(fields).map((p) => p.message)]
  const m = useMutation({
    mutationFn: () => {
      const updates: Record<string, unknown>[] = []
      if (schemaChanged) updates.push({ action: 'add-schema', schema: { type: 'struct', 'schema-id': Math.max(...md.schemas.map((s) => s['schema-id'])) + 1, fields: built } })
      updates.push({
        action: 'add-view-version',
        'view-version': {
          'version-id': Math.max(...md.versions.map((v) => v['version-id'])) + 1,
          'timestamp-ms': Date.now(),
          'schema-id': schemaChanged ? -1 : curSchema['schema-id'],
          summary: ENGINE,
          representations: reps.map((r) => ({ type: 'sql', sql: r.sql.trim(), dialect: r.dialect })),
          'default-namespace': cur?.['default-namespace'] ?? ns,
        },
      })
      updates.push({ action: 'set-current-view-version', 'view-version-id': -1 })
      return commitView(cluster, wh, ns, view, [{ type: 'assert-view-uuid', uuid: md['view-uuid'] }], updates)
    },
    onSuccess: (r) => {
      qc.setQueryData(qk.view(cluster, wh, ns, view), (old: LoadViewResult | undefined) => (old ? { ...old, ...r } : r))
      toast.success('View updated', 'A new version is now current. Earlier versions remain in the history.')
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) m.reset() }}>
      <DialogContent title="Edit view definition" description="Publishes a new version; the previous one stays in the version history." className="max-w-4xl" wide>
        <DialogBody className="max-h-[70vh]">
          <RepsEditor reps={reps} onChange={setReps} />
          <div className="flex flex-col gap-1.5">
            <Label>Output columns</Label>
            <SchemaEditor fields={fields} onChange={setFields} problems={touched ? validateFields(fields) : []} />
          </div>
          {touched && problems.length > 0 && <InlineError error={new Error(problems[0])} />}
          <InlineError error={m.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!sqlChanged && !schemaChanged} loading={m.isPending} onClick={() => { setTouched(true); if (problems.length === 0) m.mutate() }}>
            Publish version {Math.max(...md.versions.map((v) => v['version-id'])) + 1}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
