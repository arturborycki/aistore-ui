import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAuth } from '@/auth/AuthContext'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, GitMerge, Layers, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import { ApiError } from '@/lib/api'
import { commitTransaction } from '@/lib/catalog'
import { stageChange, type TableChange } from '@/lib/commits'
import { cn } from '@/lib/cn'

/**
 * A change set collects table changes (possibly across many tables of one
 * warehouse) and applies them in one atomic multi-table transaction. It lives
 * in memory only: nothing is committed until the user applies it.
 */
interface Scope {
  cluster: string
  warehouse: string
}

interface ChangeSetValue {
  scope: Scope | null
  changes: TableChange[]
  /** Adds a change; throws if it conflicts with one already staged. */
  stage: (scope: Scope, change: TableChange) => void
  remove: (index: number) => void
  clear: () => void
}

const Ctx = createContext<ChangeSetValue | null>(null)

// Staged (not yet committed) changes survive reloads of this tab. They hold
// identifiers and intended values only, never credentials, and are bound to
// the signed-in user.
const STORAGE_KEY = 'aistor-ui:changeset'

interface Stored {
  sub: string
  scope: Scope | null
  changes: TableChange[]
}

function readStored(): Stored | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    return raw ? (JSON.parse(raw) as Stored) : null
  } catch {
    return null
  }
}

function writeStored(v: Stored | null) {
  try {
    if (v && v.changes.length) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(v))
    else sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* storage unavailable: the change set stays in memory only */
  }
}

export function ChangeSetProvider({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth()
  const sub = me?.user.sub
  const [state, setState] = useState<Stored>(() => ({ sub: '', scope: null, changes: [] }))
  // Load the stored set for this user once they are known; drop it on sign-out or user switch.
  useEffect(() => {
    if (loading) return // session still resolving: neither load nor clear yet
    if (!sub) {
      setState({ sub: '', scope: null, changes: [] })
      writeStored(null)
      return
    }
    const stored = readStored()
    setState(stored && stored.sub === sub ? stored : { sub, scope: null, changes: [] })
  }, [sub, loading])
  useEffect(() => {
    if (state.sub) writeStored(state)
  }, [state])
  const { scope, changes } = state
  const setChanges = useCallback((f: (c: TableChange[]) => TableChange[]) => setState((s) => ({ ...s, changes: f(s.changes) })), [])
  const setScope = useCallback((sc: Scope) => setState((s) => ({ ...s, scope: sc })), [])
  const stage = useCallback(
    (s: Scope, c: TableChange) => {
      if (scope && changes.length && (scope.cluster !== s.cluster || scope.warehouse !== s.warehouse)) {
        throw new Error(`The change set already holds changes for warehouse ${scope.warehouse}. Transactions cannot span warehouses; apply or discard them first.`)
      }
      const next = stageChange(changes, c)
      setScope(s)
      setChanges(() => next)
    },
    [scope, changes, setScope, setChanges],
  )
  const value = useMemo<ChangeSetValue>(
    () => ({
      scope,
      changes,
      stage,
      remove: (i) => setChanges((cs) => cs.filter((_, j) => j !== i)),
      clear: () => setChanges(() => []),
    }),
    [scope, changes, stage, setChanges],
  )
  return (
    <Ctx.Provider value={value}>
      {children}
      <ChangeSetTray />
    </Ctx.Provider>
  )
}

export function useChangeSet() {
  const v = useContext(Ctx)
  if (!v) throw new Error('useChangeSet outside ChangeSetProvider')
  return v
}

function ChangeSetTray() {
  const { scope, changes, remove, clear } = useChangeSet()
  const [open, setOpen] = useState(true)
  const qc = useQueryClient()
  const toast = useToast()
  const apply = useMutation({
    mutationFn: () => commitTransaction(scope!.cluster, scope!.warehouse, changes),
    onSuccess: () => {
      const n = changes.length
      clear()
      void qc.invalidateQueries({ queryKey: ['cluster', scope!.cluster] })
      void qc.invalidateQueries({ queryKey: ['tree', scope!.cluster] })
      toast.success('Change set applied', `${n} change${n === 1 ? '' : 's'} committed atomically.`)
    },
  })
  if (!scope || changes.length === 0) return null
  const tables = new Set(changes.map((c) => [...c.identifier.namespace, c.identifier.name].join('.'))).size
  const conflict = apply.error instanceof ApiError && apply.error.isConflict
  return (
    <section
      aria-label="Change set"
      className="fixed bottom-4 left-1/2 z-[60] w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-[var(--radius-modal)] border border-border bg-bg shadow-pop animate-slide-in"
    >
      <header className="flex items-center gap-2 px-4 py-2.5">
        <GitMerge className="size-4 text-accent" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold">
            Change set <Badge tone="accent">{changes.length}</Badge>
          </div>
          <div className="truncate text-[12px] text-muted">
            {tables} table{tables === 1 ? '' : 's'} in <span className="font-mono">{scope.warehouse}</span> · applied together or not at all
          </div>
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={open ? 'Collapse change set' : 'Expand change set'} onClick={() => setOpen((o) => !o)}>
          <ChevronDown className={cn('transition-transform', !open && 'rotate-180')} />
        </Button>
      </header>
      {open && (
        <>
          <ol className="max-h-64 overflow-auto border-t border-border">
            {changes.map((c, i) => (
              <li key={i} className="flex items-start gap-2 border-b border-border px-4 py-2 last:border-0">
                <Layers className="mt-0.5 size-3.5 shrink-0 text-ent-table" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[12px] text-muted">{[...c.identifier.namespace, c.identifier.name].join('.')}</div>
                  <div className="text-[12.5px]">{c.summary}</div>
                </div>
                <Button size="icon-sm" variant="ghost" aria-label={`Remove change ${i + 1}`} onClick={() => remove(i)}>
                  <X />
                </Button>
              </li>
            ))}
          </ol>
          {apply.error && (
            <div className="px-4 pt-2">
              <InlineError error={conflict ? new Error(`A table changed after these edits were prepared (${(apply.error as Error).message}). Nothing was applied. Remove the stale change and prepare it again.`) : apply.error} />
            </div>
          )}
          <footer className="flex items-center justify-end gap-2 px-4 py-2.5">
            <Button variant="ghost" onClick={() => { clear(); apply.reset() }}>
              <Trash2 /> Discard all
            </Button>
            <Button variant="primary" onClick={() => apply.mutate()} loading={apply.isPending}>
              <GitMerge /> Apply atomically
            </Button>
          </footer>
        </>
      )}
    </section>
  )
}
