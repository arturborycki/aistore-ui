import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from '@/components/ui/dialog'
import { Field, Input } from '@/components/ui/input'
import { Checkbox, Switch } from '@/components/ui/switch'
import { InlineError } from '@/components/ui/states'
import { TypeToConfirmDialog } from '@/components/ui/confirm-dialog'
import { useToast } from '@/components/ui/toast'
import { createWarehouse, deleteWarehouse } from '@/lib/catalog'
import { WAREHOUSE_NAME_RE } from '@/lib/namespace'
import { paths } from '@/layout/paths'

export function invalidateCluster(qc: ReturnType<typeof useQueryClient>, cluster: string) {
  void qc.invalidateQueries({ queryKey: ['cluster', cluster] })
  void qc.invalidateQueries({ queryKey: ['tree', cluster] })
}

function warehouseNameError(name: string): string | null {
  if (!name) return null
  if (name.length < 3 || name.length > 63) return 'Must be 3–63 characters'
  if (!WAREHOUSE_NAME_RE.test(name)) return 'Use lowercase letters, digits and hyphens; start and end with a letter or digit'
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return 'Cannot look like an IP address'
  return null
}

export function CreateWarehouseDialog({ cluster }: { cluster: string }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [upgrade, setUpgrade] = useState(false)
  const qc = useQueryClient()
  const toast = useToast()
  const navigate = useNavigate()
  const m = useMutation({
    mutationFn: () => createWarehouse(cluster, name, upgrade),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('Warehouse created', `${name} is ready. Versioning is enabled on its bucket.`)
      setOpen(false)
      navigate(paths.warehouse(cluster, name))
    },
  })
  const err = warehouseNameError(name)
  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) {
          setName('')
          setUpgrade(false)
          m.reset()
        }
      }}
    >
      <Button variant="primary" onClick={() => setOpen(true)}>
        <Plus />
        New warehouse
      </Button>
      <DialogContent title="Create warehouse" description="A warehouse is the root container for namespaces and tables, backed by its own bucket.">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!err && name) m.mutate()
          }}
        >
          <DialogBody>
            <Field label="Name" error={err} hint="3–63 characters: lowercase letters, digits and hyphens.">
              {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} className="font-mono" placeholder="analytics" autoFocus autoComplete="off" spellCheck={false} />}
            </Field>
            <label className="flex items-start gap-3 rounded-[var(--radius-control)] border border-border p-3">
              <Switch checked={upgrade} onCheckedChange={setUpgrade} />
              <span className="text-[12.5px]">
                <span className="block font-medium text-fg">Upgrade an existing bucket</span>
                <span className="text-muted">Turn a bucket with this name into a warehouse. Versioning is enabled and can no longer be suspended.</span>
              </span>
            </label>
            <InlineError error={m.error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!name || !!err} loading={m.isPending}>
              Create warehouse
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteWarehouseDialog({
  cluster,
  warehouse,
  open,
  onOpenChange,
  onDeleted,
}: {
  cluster: string
  warehouse: string
  open: boolean
  onOpenChange: (v: boolean) => void
  onDeleted?: () => void
}) {
  const [keepBucket, setKeepBucket] = useState(true)
  const qc = useQueryClient()
  const toast = useToast()
  const m = useMutation({
    mutationFn: () => deleteWarehouse(cluster, warehouse, keepBucket),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      qc.removeQueries({ queryKey: ['cluster', cluster, 'warehouse', warehouse] })
      toast.success('Warehouse deleted', keepBucket ? `${warehouse} was removed; its bucket was kept.` : `${warehouse} and its bucket were removed.`)
      onOpenChange(false)
      onDeleted?.()
    },
  })
  return (
    <TypeToConfirmDialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v)
        if (!v) {
          m.reset()
          setKeepBucket(true)
        }
      }}
      title="Delete warehouse"
      consequence={
        <>
          <strong className="font-mono">{warehouse}</strong> will be deleted. It must not contain any namespaces. You may be asked to confirm your identity.
        </>
      }
      confirmText={warehouse}
      actionLabel="Delete warehouse"
      onConfirm={() => m.mutate()}
      pending={m.isPending}
      error={m.error}
    >
      <label className="flex items-start gap-3 text-[12.5px]">
        <Checkbox checked={keepBucket} onCheckedChange={setKeepBucket} className="mt-0.5" />
        <span>
          <span className="block font-medium">Keep the underlying bucket</span>
          <span className="text-muted">Recommended. Uncheck to delete the bucket as well.</span>
        </span>
      </label>
    </TypeToConfirmDialog>
  )
}
