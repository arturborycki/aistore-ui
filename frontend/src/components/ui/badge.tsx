import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

const tones = {
  neutral: 'bg-surface text-muted border-border',
  accent: 'bg-accent-subtle text-accent-text border-transparent',
  success: 'bg-success-subtle text-success border-transparent',
  warning: 'bg-warning-subtle text-warning border-transparent',
  danger: 'bg-danger-subtle text-danger border-transparent',
  info: 'bg-info-subtle text-info border-transparent',
}

export type Tone = keyof typeof tones

export function Badge({ tone = 'neutral', dot, children, className, mono }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; mono?: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 text-[11px] font-medium',
        mono && 'font-mono',
        tones[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden />}
      {children}
    </span>
  )
}
