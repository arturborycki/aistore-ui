import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Database, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TypeToConfirmDialog } from '@/components/ui/confirm-dialog'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input, Label } from '@/components/ui/input'
import { InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { dropTable, dropView, listAllNamespaces, renameTable, renameView } from '@/lib/catalog'
import { namespaceLabel, sameNamespace, UNIT_SEPARATOR, type Namespace } from '@/lib/namespace'
import { invalidateCluster } from '@/features/warehouses/WarehouseDialogs'

type Kind = 'table' | 'view'
const NEW_NAME_RE = /^[a-z0-9_]{1,250}$/

/** Collects all namespaces of a warehouse (breadth-first, capped). */
async function allNamespaces(cluster: string, wh: string): Promise<Namespace[]> {
  const out: Namespace[] = []
  const queue: Namespace[] = [[]]
  while (queue.length && out.length < 500) {
    const parent = queue.shift()!
    const children = await listAllNamespaces(cluster, wh, parent)
    for (const c of children) {
      out.push(c)
      queue.push(c)
    }
  }
  return out.sort((a, b) => namespaceLabel(a).localeCompare(namespaceLabel(b)))
}

export function RenameDialog({
  kind,
  cluster,
  wh,
  ns,
  name,
  open,
  onOpenChange,
  onRenamed,
}: {
  kind: Kind
  cluster: string
  wh: string
  ns: Namespace
  name: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onRenamed: (ns: Namespace, name: string) => void
}) {
  const [newName, setNewName] = useState(name)
  const [target, setTarget] = useState(ns.join(UNIT_SEPARATOR))
  useEffect(() => {
    if (open) {
      setNewName(name)
      setTarget(ns.join(UNIT_SEPARATOR))
    }
  }, [open, name, ns])
  const nss = useQuery({ queryKey: ['cluster', cluster, 'warehouse', wh, 'all-namespaces'], queryFn: () => allNamespaces(cluster, wh), enabled: open })
  const qc = useQueryClient()
  const toast = useToast()
  const dest = target.split(UNIT_SEPARATOR)
  const m = useMutation({
    mutationFn: () =>
      (kind === 'table' ? renameTable : renameView)(cluster, wh, { namespace: ns, name }, { namespace: dest, name: newName }),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success(`${kind === 'table' ? 'Table' : 'View'} renamed`, `${namespaceLabel(dest)}.${newName}`)
      onOpenChange(false)
      onRenamed(dest, newName)
    },
  })
  const err = newName && !NEW_NAME_RE.test(newName) ? 'Use 1–250 lowercase letters, digits and underscores' : null
  const unchanged = newName === name && sameNamespace(dest, ns)
  const options = nss.data ?? [ns]
  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) m.reset() }}>
      <DialogContent title={`Rename or move ${kind}`} description={<span className="font-mono">{wh}.{namespaceLabel(ns)}.{name}</span>}>
        <form onSubmit={(e) => { e.preventDefault(); if (!err && !unchanged) m.mutate() }}>
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="rename-ns">Namespace</Label>
              <select
                id="rename-ns"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 font-mono text-[12.5px]"
                disabled={nss.isPending}
              >
                {options.map((o) => (
                  <option key={o.join(UNIT_SEPARATOR)} value={o.join(UNIT_SEPARATOR)}>
                    {namespaceLabel(o)}
                  </option>
                ))}
              </select>
            </div>
            <Field label="Name" error={err}>
              {(p) => <Input {...p} value={newName} onChange={(e) => setNewName(e.target.value)} className="font-mono" autoFocus spellCheck={false} />}
            </Field>
            {kind === 'table' && <p className="text-[12px] text-muted">Access policies are unaffected: they reference the table's UUID, not its name.</p>}
            <InlineError error={m.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!!err || unchanged || !newName} loading={m.isPending}>
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DropTableDialog({
  cluster,
  wh,
  ns,
  name,
  open,
  onOpenChange,
  onDropped,
}: {
  cluster: string
  wh: string
  ns: Namespace
  name: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onDropped?: () => void
}) {
  const [purge, setPurge] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => dropTable(cluster, wh, ns, name, purge),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('Table dropped', purge ? `${name} and its data files were deleted.` : `${name} was removed from the catalog; its data files were kept.`)
      onOpenChange(false)
      onDropped?.()
    },
  })
  const option = (value: boolean, title: string, text: string, icon: React.ReactNode) => (
    <label className={cn('flex cursor-pointer items-start gap-3 rounded-[var(--radius-control)] border p-3', purge === value ? (value ? 'border-danger bg-danger-subtle/50' : 'border-accent bg-accent-subtle/40') : 'border-border')}>
      <input type="radio" name="purge" checked={purge === value} onChange={() => setPurge(value)} className="mt-1 accent-[var(--accent)]" />
      <span className="text-[12.5px]">
        <span className="flex items-center gap-1.5 font-medium text-fg">
          {icon}
          {title}
        </span>
        <span className="text-muted">{text}</span>
      </span>
    </label>
  )
  return (
    <TypeToConfirmDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          setPurge(false)
          m.reset()
        }
      }}
      title="Drop table"
      consequence={
        <>
          <strong className="font-mono">{namespaceLabel(ns)}.{name}</strong> will be removed from the catalog.{' '}
          {purge ? 'Its data and metadata files will be permanently deleted.' : 'Its files stay in the warehouse bucket and the table can be registered again.'}
        </>
      }
      confirmText={name}
      actionLabel={purge ? 'Drop and delete data' : 'Drop table'}
      onConfirm={() => m.mutate()}
      pending={m.isPending}
      error={m.error}
    >
      <div className="flex flex-col gap-2">
        {option(false, 'Keep data files', 'Only the catalog entry is removed (purgeRequested=false).', <Database className="size-3.5" />)}
        {option(true, 'Purge data files', 'Deletes all data and metadata files. You will be asked to confirm your identity.', <Trash2 className="size-3.5 text-danger" />)}
      </div>
    </TypeToConfirmDialog>
  )
}

export function DropViewDialog({
  cluster,
  wh,
  ns,
  name,
  open,
  onOpenChange,
  onDropped,
}: {
  cluster: string
  wh: string
  ns: Namespace
  name: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onDropped?: () => void
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => dropView(cluster, wh, ns, name),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('View dropped', name)
      onOpenChange(false)
      onDropped?.()
    },
  })
  return (
    <TypeToConfirmDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) m.reset()
      }}
      title="Drop view"
      consequence={
        <>
          <strong className="font-mono">{namespaceLabel(ns)}.{name}</strong> will be removed. Queries that use it will fail. Table data is not affected.
        </>
      }
      confirmText={name}
      actionLabel="Drop view"
      onConfirm={() => m.mutate()}
      pending={m.isPending}
      error={m.error}
    />
  )
}
