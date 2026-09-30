import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitMerge, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import { ApiError } from '@/lib/api'
import { commitTableChange } from '@/lib/catalog'
import type { TableChange } from '@/lib/commits'
import type { LoadTableResult } from '@/lib/iceberg'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { useChangeSet } from '@/features/changeset/ChangeSet'

/** Commits a table change now, or stages it into the multi-table change set. */
export function useTableCommit(cluster: string, wh: string, ns: Namespace, table: string) {
  const qc = useQueryClient()
  const toast = useToast()
  const changeSet = useChangeSet()
  const [stageError, setStageError] = useState<unknown>(null)
  const key = qk.table(cluster, wh, ns, table)
  const m = useMutation({
    mutationFn: (c: TableChange) => commitTableChange(cluster, wh, c),
    onSuccess: (r, c) => {
      if (r?.metadata) qc.setQueryData(key, (old: LoadTableResult | undefined) => (old ? { ...old, ...r } : r))
      void qc.invalidateQueries({ queryKey: key })
      void qc.invalidateQueries({ queryKey: ['tree', cluster] })
      toast.success('Committed', c.summary)
    },
  })
  return {
    apply: (c: TableChange, onDone?: () => void) => {
      setStageError(null)
      m.mutate(c, { onSuccess: () => onDone?.() })
    },
    stage: (c: TableChange, onDone?: () => void) => {
      m.reset()
      try {
        changeSet.stage({ cluster, warehouse: wh }, c)
        setStageError(null)
        toast.info('Added to change set', c.summary)
        onDone?.()
      } catch (e) {
        setStageError(e)
      }
    },
    pending: m.isPending,
    error: m.error ?? stageError,
    conflict: m.error instanceof ApiError && m.error.isConflict,
    reset: () => {
      m.reset()
      setStageError(null)
    },
    reload: () => qc.invalidateQueries({ queryKey: key }),
  }
}

export type TableCommit = ReturnType<typeof useTableCommit>

/** Footer for editors: explains conflicts and offers apply-now / add-to-change-set. */
export function CommitBar({
  commit,
  build,
  disabled,
  onDone,
  onCancel,
  applyLabel = 'Apply now',
  errorsOnly = false,
}: {
  commit: TableCommit
  build: () => TableChange | null
  disabled?: boolean
  onDone?: () => void
  onCancel?: () => void
  applyLabel?: string
  /** render only the error / conflict notice */
  errorsOnly?: boolean
}) {
  return (
    <div className="flex flex-col gap-2">
      {commit.conflict ? (
        <div role="alert" className="flex items-center gap-3 rounded-[var(--radius-control)] bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
          <span className="flex-1">
            Someone changed this table after you opened the editor, so nothing was committed ({(commit.error as Error).message}). Reload to see the latest version, then redo your edit.
          </span>
          <Button size="sm" variant="outline" onClick={() => { commit.reset(); void commit.reload(); onCancel?.() }}>
            <RefreshCw /> Reload
          </Button>
        </div>
      ) : (
        <InlineError error={commit.error} />
      )}
      {!errorsOnly && <div className="flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button
          variant="outline"
          disabled={disabled || commit.pending}
          onClick={() => {
            const c = build()
            if (c) commit.stage(c, onDone)
          }}
        >
          <GitMerge /> Add to change set
        </Button>
        <Button
          variant="primary"
          disabled={disabled}
          loading={commit.pending}
          onClick={() => {
            const c = build()
            if (c) commit.apply(c, onDone)
          }}
        >
          {applyLabel}
        </Button>
      </div>}
    </div>
  )
}
