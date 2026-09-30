import * as D from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const Dialog = D.Root
export const DialogTrigger = D.Trigger
export const DialogClose = D.Close

export function DialogContent({
  title,
  description,
  children,
  className,
  wide,
}: {
  title: ReactNode
  description?: ReactNode
  children: ReactNode
  className?: string
  wide?: boolean
}) {
  return (
    <D.Portal>
      <D.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-fade-in" />
      <D.Content
        className={cn(
          'fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-2rem)] -translate-x-1/2 rounded-[var(--radius-modal)] border border-border bg-bg shadow-pop',
          'data-[state=open]:animate-pop-in focus:outline-none',
          wide ? 'max-w-2xl' : 'max-w-md',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <D.Title className="text-[15px] font-semibold leading-6">{title}</D.Title>
            {description ? (
              <D.Description className="mt-0.5 text-[12.5px] text-muted">{description}</D.Description>
            ) : (
              <D.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</D.Description>
            )}
          </div>
          <D.Close className="rounded p-1 text-muted hover:bg-surface hover:text-fg" aria-label="Close">
            <X className="size-4" />
          </D.Close>
        </div>
        {children}
      </D.Content>
    </D.Portal>
  )
}

export function DialogBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('flex max-h-[60vh] flex-col gap-4 overflow-y-auto px-5 py-4', className)}>{children}</div>
}

export function DialogFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-end gap-2 rounded-b-[var(--radius-modal)] border-t border-border bg-bg-subtle px-5 py-3', className)}>
      {children}
    </div>
  )
}
