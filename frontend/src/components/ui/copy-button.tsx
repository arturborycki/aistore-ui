import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/cn'
import { Tooltip } from './tooltip'

export function CopyButton({ value, label = 'Copy', className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <Tooltip content={done ? 'Copied' : label}>
      <button
        type="button"
        aria-label={label}
        onClick={async (e) => {
          e.stopPropagation()
          try {
            await navigator.clipboard.writeText(value)
            setDone(true)
            window.setTimeout(() => setDone(false), 1200)
          } catch {
            /* clipboard blocked */
          }
        }}
        className={cn('inline-flex size-6 items-center justify-center rounded text-subtle hover:bg-surface hover:text-fg', className)}
      >
        {done ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </Tooltip>
  )
}

/** Monospace value with copy-on-hover. */
export function CopyText({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('group inline-flex min-w-0 items-center gap-1', className)}>
      <span className="truncate font-mono text-[12px]">{value}</span>
      <CopyButton value={value} className="opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100" />
    </span>
  )
}
