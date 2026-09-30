import { CircleAlert, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/cn'
import type { Problem } from '@/lib/ossie'

/** Validation findings with their document path; errors first. */
export function ProblemList({ problems, title, onSelect, className }: { problems: Problem[]; title?: string; onSelect?: (p: Problem) => void; className?: string }) {
  if (!problems.length) return null
  const sorted = [...problems].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1))
  const errors = problems.filter((p) => p.severity === 'error').length
  return (
    <div role={errors ? 'alert' : 'status'} className={cn('rounded-[var(--radius-control)] border px-3 py-2', errors ? 'border-danger/40 bg-danger-subtle' : 'border-warning/40 bg-warning-subtle', className)}>
      {title && <p className={cn('mb-1 text-[12.5px] font-medium', errors ? 'text-danger' : 'text-warning')}>{title}</p>}
      <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
        {sorted.map((p, i) => {
          const body = (
            <>
              {p.severity === 'error' ? <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-danger" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" />}
              <span className="min-w-0">
                {p.path && <span className="mr-1.5 font-mono text-[11.5px] text-muted">{p.path}</span>}
                <span className="text-[12.5px] text-fg">{p.message}</span>
              </span>
            </>
          )
          return (
            <li key={i}>
              {onSelect && p.path ? (
                <button type="button" onClick={() => onSelect(p)} className="flex w-full items-start gap-1.5 rounded text-left hover:underline">
                  {body}
                </button>
              ) : (
                <div className="flex items-start gap-1.5">{body}</div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
