import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Label } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { TypeToConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import { createNamespace, deleteNamespace } from '@/lib/catalog'
import { namespaceLabel, validateLevel, type Namespace } from '@/lib/namespace'
import { paths } from '@/layout/paths'
import { invalidateCluster } from '@/features/warehouses/WarehouseDialogs'

const MAX_LEVELS = 10

export function CreateNamespaceDialog({ cluster, warehouse, parent, trigger }: { cluster: string; warehouse: string; parent: Namespace; trigger?: 'button' | 'small' }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [props, setProps] = useState<{ k: string; v: string }[]>([])
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const full = [...parent, name]
  const m = useMutation({
    mutationFn: () =>
      createNamespace(
        cluster,
        warehouse,
        full,
        Object.fromEntries(props.filter((p) => p.k).map((p) => [p.k, p.v])),
      ),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('Namespace created', namespaceLabel(full))
      setOpen(false)
      navigate(paths.namespace(cluster, warehouse, full))
    },
  })
  const err = name ? validateLevel(name) : null
  const tooDeep = full.length > MAX_LEVELS
  const reset = () => {
    setName('')
    setProps([])
    m.reset()
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <Button variant={trigger === 'small' ? 'outline' : 'primary'} size={trigger === 'small' ? 'sm' : 'md'} onClick={() => setOpen(true)} disabled={parent.length >= MAX_LEVELS}>
        <Plus />
        {parent.length ? 'New child namespace' : 'New namespace'}
      </Button>
      <DialogContent
        title={parent.length ? 'Create child namespace' : 'Create namespace'}
        description={
          <>
            In <span className="font-mono">{warehouse}{parent.length ? `.${namespaceLabel(parent)}` : ''}</span>
          </>
        }
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name && !err && !tooDeep) m.mutate()
          }}
        >
          <DialogBody>
            <Field label="Name" error={err ?? (tooDeep ? `Namespaces can be nested at most ${MAX_LEVELS} levels deep` : null)}>
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" placeholder="sales" autoFocus autoComplete="off" spellCheck={false} />}
            </Field>
            <div className="flex flex-col gap-1.5">
              <Label>Properties</Label>
              {props.map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input aria-label="Key" placeholder="owner" value={p.k} onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))} className="font-mono text-[12px]" />
                  <Input aria-label="Value" placeholder="data-team" value={p.v} onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))} className="font-mono text-[12px]" />
                  <Button size="icon-sm" variant="ghost" aria-label="Remove" onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" onClick={() => setProps((ps) => [...ps, { k: '', v: '' }])}>
                  <Plus />
                  Add property
                </Button>
              </div>
            </div>
            <InlineError error={m.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name || !!err || tooDeep} loading={m.isPending}>
              Create namespace
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteNamespaceDialog({
  cluster,
  warehouse,
  ns,
  open,
  onOpenChange,
  onDeleted,
}: {
  cluster: string
  warehouse: string
  ns: Namespace
  open: boolean
  onOpenChange: (v: boolean) => void
  onDeleted?: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => deleteNamespace(cluster, warehouse, ns),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('Namespace deleted', namespaceLabel(ns))
      onOpenChange(false)
      onDeleted?.()
    },
  })
  const label = namespaceLabel(ns)
  return (
    <TypeToConfirmDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) m.reset()
      }}
      title="Delete namespace"
      consequence={
        <>
          <strong className="font-mono">{label}</strong> will be deleted. AIStor only deletes empty namespaces: drop or move its tables, views and child namespaces first.
        </>
      }
      confirmText={ns[ns.length - 1]}
      actionLabel="Delete namespace"
      onConfirm={() => m.mutate()}
      pending={m.isPending}
      error={m.error}
    />
  )
}
