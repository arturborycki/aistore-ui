import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router'
import { BookOpenText, ExternalLink, Plus, Save, Undo2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { EntityIcon } from '@/components/ui/entity-icon'
import { Field, Input } from '@/components/ui/input'
import { Card, CardHeader } from '@/components/ui/layout'
import { EmptyState, ErrorState, InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import type { Namespace } from '@/lib/namespace'
import { MODEL_NAME_RE, ossie, semanticKeys, type Usage } from '@/lib/ossie'
import { paths } from '@/layout/paths'
import { DatasetEditor } from './DatasetsPanel'
import { ProblemList } from './ProblemList'
import { useModelEditor } from './useModelEditor'

/** Edits the table's dataset inside one model, saving that model. */
function UsageEditor({ cluster, u }: { cluster: string; u: Usage }) {
  const ed = useModelEditor(cluster, u.warehouse, u.namespace, u.model)
  const toast = useToast()
  const model = ed.draft
  const index = model?.datasets.findIndex((d) => d.name === u.dataset) ?? -1
  const errors = ed.problems.filter((p) => p.severity === 'error')
  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            <EntityIcon kind="model" />
            <Link to={paths.model(cluster, u.warehouse, u.namespace, u.model)} className="font-mono hover:underline">
              {u.model}
            </Link>
            <span className="font-normal text-muted">as dataset</span>
            <span className="font-mono">{u.dataset}</span>
          </span>
        }
        description={[u.relationships?.length && `${u.relationships.length} relationship(s)`, u.metrics?.length && `used by metrics: ${u.metrics.join(', ')}`].filter(Boolean).join(' · ') || undefined}
        actions={
          <Link to={paths.model(cluster, u.warehouse, u.namespace, u.model, 'datasets')} className="inline-flex items-center gap-1 text-[12px] text-accent-text hover:underline">
            Open model <ExternalLink className="size-3" />
          </Link>
        }
      />
      <div className="p-3">
        {ed.doc.isError && <ErrorState error={ed.doc.error} compact />}
        {model && index >= 0 && <DatasetEditor model={model} ds={model.datasets[index]} index={index} setDraft={ed.setDraft} problems={ed.problems} />}
        {model && index < 0 && <p className="text-[12.5px] text-muted">The dataset was renamed in the model; open the model to edit it.</p>}
      </div>
      {(ed.dirty || ed.save.isError) && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-2.5">
          {ed.conflict && <InlineError error={ed.save.error} />}
          {errors.length > 0 && <ProblemList problems={errors} />}
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={ed.discard}>
              <Undo2 /> Discard
            </Button>
            <Button size="sm" variant="primary" disabled={!ed.dirty || errors.length > 0} loading={ed.save.isPending} onClick={() => ed.save.mutate(undefined, { onSuccess: () => toast.success(`Saved ${u.model}`) })}>
              <Save /> Save {u.model}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

function AddToModelDialog({ cluster, wh, ns, table, open, onOpenChange }: { cluster: string; wh: string; ns: Namespace; table: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const models = useQuery({ queryKey: semanticKeys.list(cluster, wh, ns), queryFn: () => ossie.list(cluster, wh, ns), enabled: open })
  const [target, setTarget] = useState<string>('__new')
  const [name, setName] = useState(table.replace(/[^A-Za-z0-9_-]/g, '_'))
  const qc = useQueryClient()
  const navigate = useNavigate()
  const add = useMutation({
    mutationFn: async () => {
      if (target === '__new') {
        await ossie.create(cluster, wh, ns, { name, tables: [{ namespace: ns, name: table }] })
        return name
      }
      const doc = await ossie.get(cluster, wh, ns, target)
      if (!doc.model) throw new Error('That model is not valid; open it to repair it first.')
      const [ds] = await ossie.generate(cluster, wh, [{ namespace: ns, name: table }], doc.model.datasets.map((d) => d.name))
      await ossie.save(cluster, wh, ns, target, { ...doc.model, datasets: [...doc.model.datasets, ds] }, doc.etag)
      return target
    },
    onSuccess: (m) => {
      void qc.invalidateQueries({ queryKey: ['semantic'] })
      onOpenChange(false)
      navigate(paths.model(cluster, wh, ns, m, 'datasets'))
    },
  })
  const ok = target !== '__new' || MODEL_NAME_RE.test(name)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={`Describe ${table} in a semantic model`} description="The table becomes a dataset: every column a field, with types, docs and the row key.">
        <DialogBody>
          <Field label="Model">
            {(p) => (
              <select {...p} value={target} onChange={(e) => setTarget(e.target.value)} className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]">
                <option value="__new">New model…</option>
                {models.data?.models.map((m) => (
                  <option key={m.name} value={m.name}>
                    {m.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {target === '__new' && <Field label="New model name">{(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" />}</Field>}
          <InlineError error={add.error} />
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} loading={add.isPending} onClick={() => add.mutate()}>
            <Plus /> Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function SemanticsTab({ cluster, wh, ns, table, uuid }: { cluster: string; wh: string; ns: Namespace; table: string; uuid: string }) {
  const q = useQuery({ queryKey: semanticKeys.usage(cluster, wh, uuid), queryFn: () => ossie.usage(cluster, wh, { table: uuid, namespace: ns, name: table }) })
  const [adding, setAdding] = useState(false)
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const usage = q.data?.usage ?? []
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-2xl text-[12.5px] text-muted">
          Business meaning of this table's columns, stored in Apache Ossie semantic models. Edits here are saved to the model shown.
        </p>
        {q.data?.truncated && <Badge tone="warning">Not all models were checked</Badge>}
        <Button variant="outline" onClick={() => setAdding(true)}>
          <BookOpenText /> Add to a model
        </Button>
      </div>
      {q.isPending ? (
        <p className="text-[12.5px] text-muted">Looking for models that use this table…</p>
      ) : usage.length === 0 ? (
        <EmptyState icon={<BookOpenText />} title="Not in any semantic model" action={<Button onClick={() => setAdding(true)}><Plus /> Add to a model</Button>}>
          Add business names, descriptions, synonyms, joins and metrics for this table, so people and AI agents query it correctly.
        </EmptyState>
      ) : (
        usage.map((u) => <UsageEditor key={`${u.namespace.join('.')}/${u.model}/${u.dataset}`} cluster={cluster} u={u} />)
      )}
      <AddToModelDialog cluster={cluster} wh={wh} ns={ns} table={table} open={adding} onOpenChange={setAdding} />
    </div>
  )
}
