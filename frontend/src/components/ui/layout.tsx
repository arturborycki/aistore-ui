import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { Skeleton } from './skeleton'

export function PageHeader({ icon, title, subtitle, badges, actions }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; badges?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        {icon}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-[18px] font-semibold tracking-tight">{title}</h1>
            {badges}
          </div>
          {subtitle && <div className="mt-0.5 text-[12.5px] text-muted">{subtitle}</div>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('rounded-[var(--radius-card)] border border-border bg-bg', className)}>{children}</div>
}

export function CardHeader({ title, actions, description }: { title: ReactNode; actions?: ReactNode; description?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
      <div>
        <h2 className="text-[13px] font-semibold">{title}</h2>
        {description && <p className="text-[12px] text-muted">{description}</p>}
      </div>
      {actions}
    </div>
  )
}

export function StatCard({ label, value, hint, icon, loading }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; loading?: boolean }) {
  return (
    <Card className="px-4 py-3">
      <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wide text-subtle">
        {label}
        <span className="[&_svg]:size-4">{icon}</span>
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tracking-tight tabular">{loading ? <Skeleton className="h-7 w-20" /> : value}</div>
      {hint && <div className="mt-0.5 text-[12px] text-muted">{hint}</div>}
    </Card>
  )
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-[minmax(120px,max-content)_1fr] gap-x-6 gap-y-2.5 text-[13px]">
      {items.map((it) => (
        <div key={it.label} className="contents">
          <dt className="text-muted">{it.label}</dt>
          <dd className="min-w-0">{it.value}</dd>
        </div>
      ))}
    </dl>
  )
}
