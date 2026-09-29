import type { ReactNode } from 'react'
import { CircleAlert, LockKeyhole, SearchX, WifiOff } from 'lucide-react'
import { ApiError } from '@/lib/api'
import { cn } from '@/lib/cn'
import { CopyButton } from './copy-button'
import { Button } from './button'

export function EmptyState({ icon, title, children, action, className }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 rounded-[var(--radius-card)] border border-dashed border-border px-6 py-12 text-center', className)}>
      {icon && <div className="mb-1 text-subtle [&_svg]:size-8 [&_svg]:stroke-[1.25]">{icon}</div>}
      <p className="text-[14px] font-medium">{title}</p>
      {children && <div className="max-w-md text-[12.5px] text-muted">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

function policySnippet(action: string, resource: string) {
  return JSON.stringify(
    { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: [action], Resource: [resource] }] },
    null,
    2,
  )
}

/**
 * Explains a failed request. Access-denied errors name the exact s3tables
 * action and resource ARN so the user can request the right permission.
 */
export function ErrorState({ error, onRetry, className, compact }: { error: unknown; onRetry?: () => void; className?: string; compact?: boolean }) {
  const e = error instanceof ApiError ? error : null
  if (e?.isAccessDenied) {
    return (
      <EmptyState icon={<LockKeyhole />} title="You don't have access" className={className}>
        <p>AIStor denied this request for your identity.</p>
        {e.action && (
          <div className="mt-3 flex flex-col items-stretch gap-1.5 text-left">
            <div className="flex items-center justify-between gap-2 rounded-[var(--radius-control)] bg-surface px-2.5 py-1.5">
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-subtle">Required permission</div>
                <div className="truncate font-mono text-[12px] text-fg">{e.action}</div>
                {e.resource && <div className="truncate font-mono text-[11.5px] text-muted">{e.resource}</div>}
              </div>
              {e.resource && <CopyButton value={policySnippet(e.action, e.resource)} label="Copy policy statement" />}
            </div>
            <p className="text-[12px] text-subtle">Ask your AIStor administrator to grant this permission.</p>
          </div>
        )}
      </EmptyState>
    )
  }
  if (e?.isNotFound) {
    return (
      <EmptyState icon={<SearchX />} title="Not found" className={className}>
        It may have been renamed or deleted by someone else.
      </EmptyState>
    )
  }
  const offline = e?.type === 'NetworkError' || e?.type === 'UpstreamUnavailable' || e?.type === 'UpstreamTimeout'
  const message = e?.message ?? (error instanceof Error ? error.message : 'Something went wrong')
  if (compact) {
    return (
      <div className={cn('flex items-center gap-2 rounded-[var(--radius-control)] bg-danger-subtle px-3 py-2 text-[12.5px] text-danger', className)}>
        <CircleAlert className="size-4 shrink-0" />
        <span className="min-w-0 flex-1">{message}</span>
        {onRetry && (
          <Button size="sm" variant="ghost" onClick={onRetry}>
            Retry
          </Button>
        )}
      </div>
    )
  }
  return (
    <EmptyState
      icon={offline ? <WifiOff /> : <CircleAlert />}
      title={offline ? 'Catalog unavailable' : 'Request failed'}
      className={className}
      action={onRetry && <Button onClick={onRetry}>Try again</Button>}
    >
      <p>{message}</p>
      {e?.requestId && <p className="mt-1 font-mono text-[11px] text-subtle">request {e.requestId}</p>}
    </EmptyState>
  )
}

export function InlineError({ error }: { error: unknown }) {
  if (!error) return null
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <div role="alert" className="flex items-start gap-2 rounded-[var(--radius-control)] bg-danger-subtle px-3 py-2 text-[12.5px] text-danger">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 break-words">{msg}</span>
    </div>
  )
}
