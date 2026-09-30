import { useEffect, useState, type ReactNode } from 'react'
import { TriangleAlert } from 'lucide-react'
import { Button } from './button'
import { Dialog, DialogBody, DialogContent, DialogFooter } from './dialog'
import { Field, Input } from './input'
import { InlineError } from './states'

/**
 * Destructive confirmation: states the consequence and requires typing the
 * resource name before the (red) action button is enabled.
 */
export function TypeToConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmText,
  actionLabel,
  onConfirm,
  children,
  pending,
  error,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  title: string
  consequence: ReactNode
  confirmText: string
  actionLabel: string
  onConfirm: () => void
  children?: ReactNode
  pending?: boolean
  error?: unknown
}) {
  const [typed, setTyped] = useState('')
  useEffect(() => {
    if (!open) setTyped('')
  }, [open])
  const matches = typed === confirmText
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title}>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (matches && !pending) onConfirm()
          }}
        >
          <DialogBody>
            <div className="flex gap-3 rounded-[var(--radius-control)] bg-danger-subtle px-3 py-2.5 text-[12.5px] text-danger">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" />
              <div className="min-w-0">{consequence}</div>
            </div>
            {children}
            <Field
              label={
                <>
                  Type <span className="font-mono font-semibold">{confirmText}</span> to confirm
                </>
              }
            >
              {(p) => <Input {...p} autoComplete="off" spellCheck={false} value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" autoFocus />}
            </Field>
            <InlineError error={error} />
          </DialogBody>
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="danger" disabled={!matches} loading={pending}>
              {actionLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
