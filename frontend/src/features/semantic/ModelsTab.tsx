import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { FileUp, Plus, TriangleAlert } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { DataTable, type Column } from '@/components/ui/data-table'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Field, Input, Textarea } from '@/components/ui/input'
import { EmptyState, ErrorState, InlineError } from '@/components/ui/states'
import { Checkbox } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { listAllTables } from '@/lib/catalog'
import { formatDateTime, formatRelative } from '@/lib/format'
import { MODEL_NAME_RE, ModelError, ossie, semanticKeys, type ModelSummary, type Problem } from '@/lib/ossie'
import type { Namespace } from '@/lib/namespace'
import { paths } from '@/layout/paths'
import { ProblemList } from './ProblemList'

export function useSemanticEnabled() {
  return useMe().features?.semantic?.enabled === true
}

export function ModelsTab({ cluster, wh, ns }: { cluster: string; wh: string; ns: Namespace }) {
  const q = useQuery({ queryKey: semanticKeys.list(cluster, wh, ns), queryFn: () => ossie.list(cluster, wh, ns) })
  const [creating, setCreating] = useState(false)
  const [importing, setImporting] = useState(false)

  const columns: Column<ModelSummary>[] = [
    {
      key: 'name',
      header: 'Model',
      cell: (m) => (
        <Link to={paths.model(cluster, wh, ns, m.name)} className="flex items-center gap-2 font-mono text-[12.5px] font-medium hover:underline">
          <EntityIcon kind="model" />
          {m.name}
          {m.invalid && (
            <Tooltip content="The stored document is not a valid Ossie model; open it to fix the YAML.">
              <span>
                <Badge tone="danger">
                  <TriangleAlert className="size-3" /> Invalid
                </Badge>
              </span>
            </Tooltip>
          )}
        </Link>
      ),
    },
    { key: 'desc', header: 'Description', cell: (m) => <span className="line-clamp-2 text-muted">{m.description || '—'}</span> },
    { key: 'ds', header: 'Datasets', align: 'right', cell: (m) => <span className="tabular">{m.datasets}</span> },
    { key: 'rel', header: 'Relationships', align: 'right', cell: (m) => <span className="tabular">{m.relationships}</span> },
    { key: 'met', header: 'Metrics', align: 'right', cell: (m) => <span className="tabular">{m.metrics}</span> },
    {
      key: 'mod',
      header: 'Updated',
      cell: (m) => (
        <Tooltip content={formatDateTime(m.lastModified)}>
          <span className="text-muted">{formatRelative(m.lastModified)}</span>
        </Tooltip>
      ),
    },
  ]

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-2xl text-[12.5px] text-muted">
          Apache Ossie semantic models describe what the data means: business names, synonyms, keys, joins, metrics and hints for AI agents. They are stored as YAML in{' '}
          <span className="font-mono">{q.data?.bucket ?? 'the semantic bucket'}</span> and follow renames in the catalog.
        </p>
        <Button variant="outline" onClick={() => setImporting(true)}>
          <FileUp /> Import YAML
        </Button>
        <Button variant="primary" onClick={() => setCreating(true)}>
          <Plus /> New model
        </Button>
      </div>
      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <DataTable
          columns={columns}
          rows={q.data?.models ?? []}
          rowKey={(m) => m.key}
          loading={q.isPending}
          empty={
            <EmptyState icon={<EntityIcon kind="model" />} title="No semantic models yet" className="m-3 border-0" action={<Button onClick={() => setCreating(true)}><Plus /> New model</Button>}>
              Start from this namespace's tables: columns, types, docs and row keys are filled in for you.
            </EmptyState>
          }
        />
      )}
      <NewModelDialog cluster={cluster} wh={wh} ns={ns} open={creating} onOpenChange={setCreating} />
      <ImportModelDialog cluster={cluster} wh={wh} ns={ns} open={importing} onOpenChange={setImporting} />
    </div>
  )
}

function useCreate(cluster: string, wh: string, ns: Namespace, onDone: () => void) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  return useMutation({
    mutationFn: (body: Parameters<typeof ossie.create>[3]) => ossie.create(cluster, wh, ns, body),
    onSuccess: (r, body) => {
      void qc.invalidateQueries({ queryKey: semanticKeys.list(cluster, wh, ns) })
      onDone()
      navigate(paths.model(cluster, wh, ns, body.name, r.problems.length ? 'datasets' : undefined))
    },
  })
}

function NameField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const bad = value !== '' && !MODEL_NAME_RE.test(value)
  return (
    <Field label="Model name" hint="Letters, digits, _ and -. Also the file name and the model's name in Ossie." error={bad ? 'Use letters, digits, _ and - only, starting with a letter or digit.' : null}>
      {(p) => <Input {...p} value={value} onChange={(e) => onChange(e.target.value)} placeholder="retail" autoFocus spellCheck={false} className="font-mono" />}
    </Field>
  )
}

export function NewModelDialog({ cluster, wh, ns, open, onOpenChange }: { cluster: string; wh: string; ns: Namespace; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const tables = useQuery({ queryKey: ['semantic-new', cluster, wh, ns.join('\u001f')], queryFn: () => listAllTables(cluster, wh, ns), enabled: open })
  const create = useCreate(cluster, wh, ns, () => {
    onOpenChange(false)
    setName('')
    setDescription('')
    setPicked([])
  })
  const ok = MODEL_NAME_RE.test(name) && picked.length > 0
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="New semantic model" description="Datasets are generated from the tables you pick. You can add tables from other namespaces later." wide>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) create.mutate({ name, description: description || undefined, tables: picked.map((t) => ({ namespace: ns, name: t })) })
          }}
        >
          <DialogBody>
            <NameField value={name} onChange={setName} />
            <Field label="Description">{(p) => <Input {...p} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this model is for" />}</Field>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-[12px] font-medium">Tables</legend>
              {tables.isPending && <p className="text-[12.5px] text-muted">Loading tables…</p>}
              {tables.isError && <InlineError error={tables.error} />}
              {tables.data?.length === 0 && <p className="text-[12.5px] text-muted">This namespace has no tables.</p>}
              <div className="grid max-h-56 grid-cols-2 gap-1 overflow-y-auto">
                {tables.data?.map((t) => (
                  <label key={t.name} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 hover:bg-surface">
                    <Checkbox label={`Include ${t.name}`} checked={picked.includes(t.name)} onCheckedChange={(v) => setPicked(v ? [...picked, t.name] : picked.filter((x) => x !== t.name))} />
                    <EntityIcon kind="table" className="size-3.5" />
                    <span className="truncate font-mono text-[12.5px]">{t.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <CreateError error={create.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!ok} loading={create.isPending}>
              Create model
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function CreateError({ error }: { error: unknown }) {
  if (!error) return null
  if (error instanceof ModelError) return <ProblemList problems={error.problems as Problem[]} title={error.message} />
  return <InlineError error={error} />
}

export function ImportModelDialog({ cluster, wh, ns, open, onOpenChange }: { cluster: string; wh: string; ns: Namespace; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState('')
  const [raw, setRaw] = useState('')
  const create = useCreate(cluster, wh, ns, () => {
    onOpenChange(false)
    setName('')
    setRaw('')
  })
  const ok = MODEL_NAME_RE.test(name) && raw.trim() !== ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Import an Ossie model" description="Paste or upload an Apache Ossie document (YAML or JSON). It is validated against the official schema before it is stored." wide>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (ok) create.mutate({ name, raw })
          }}
        >
          <DialogBody>
            <NameField value={name} onChange={setName} />
            <Field label="Document">
              {(p) => (
                <Textarea {...p} value={raw} onChange={(e) => setRaw(e.target.value)} rows={12} spellCheck={false} className="font-mono text-[12px]" placeholder={'version: "0.2.0.dev0"\nname: …\ndatasets:\n  - name: …'} />
              )}
            </Field>
            <label className="flex items-center gap-2 text-[12.5px] text-muted">
              Or choose a file
              <input
                type="file"
                accept=".yaml,.yml,.json,application/yaml,application/json"
                aria-label="Choose an Ossie file"
                className="text-[12px]"
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  if (!f) return
                  if (f.size > 1 << 20) {
                    setRaw('')
                    return
                  }
                  setRaw(await f.text())
                  if (!name) setName(f.name.replace(/\.(ossie\.)?(ya?ml|json)$/i, '').replace(/[^A-Za-z0-9_-]/g, '_'))
                }}
              />
            </label>
            <p className="text-[12px] text-muted">The document's name is replaced by the model name above.</p>
            <CreateError error={create.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" disabled={!ok} loading={create.isPending}>
              Import
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
