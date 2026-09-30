import { useMemo } from 'react'
import { cn } from '@/lib/cn'
import { diffLines, foldDiff } from '@/lib/diff'

/** Unified line diff with folded context. */
export function DiffView({ before, after, label, className }: { before: string; after: string; label: string; className?: string }) {
  const rows = useMemo(() => foldDiff(diffLines(before, after)), [before, after])
  const changed = rows.some((r) => r.kind === 'add' || r.kind === 'del')
  if (!changed) return <p className="px-4 py-6 text-center text-[12.5px] text-muted">No differences.</p>
  return (
    <pre aria-label={label} tabIndex={0} className={cn('overflow-auto py-2 font-mono text-[12px] leading-5', className)}>
      {rows.map((d, i) =>
        d.kind === 'fold' ? (
          <div key={i} className="select-none bg-bg-subtle px-3 text-[11px] text-subtle">
            ⋯ {d.count} unchanged line{d.count === 1 ? '' : 's'}
          </div>
        ) : (
          <div key={i} className={cn('flex', d.kind === 'add' && 'bg-success-subtle', d.kind === 'del' && 'bg-danger-subtle')}>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-subtle">{d.a ?? ''}</span>
            <span className="w-10 shrink-0 select-none pr-2 text-right text-subtle">{d.b ?? ''}</span>
            <span className={cn('w-5 shrink-0 select-none text-center', d.kind === 'add' ? 'text-success' : d.kind === 'del' ? 'text-danger' : 'text-subtle')}>
              {d.kind === 'add' ? '+' : d.kind === 'del' ? '−' : ' '}
            </span>
            <code className="whitespace-pre pr-4">{d.text}</code>
          </div>
        ),
      )}
    </pre>
  )
}
