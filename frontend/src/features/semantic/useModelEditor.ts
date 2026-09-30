import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError } from '@/lib/api'
import type { Namespace } from '@/lib/namespace'
import { ModelError, ossie, sameModel, semanticKeys, type ModelDoc, type OssieModel, type Problem } from '@/lib/ossie'

/**
 * Editing state for one model: the saved document, a draft, live server-side
 * validation of the draft, and saving with optimistic concurrency (If-Match).
 */
export function useModelEditor(cluster: string, wh: string, ns: Namespace, name: string) {
  const qc = useQueryClient()
  const nsKey = ns.join('\u001f')
  const key = useMemo(() => semanticKeys.model(cluster, wh, nsKey.split('\u001f'), name), [cluster, wh, nsKey, name])
  const doc = useQuery({ queryKey: key, queryFn: () => ossie.get(cluster, wh, ns, name), staleTime: 30_000 })

  const [base, setBase] = useState<{ etag: string; model: OssieModel | null } | null>(null)
  const [draft, setDraftState] = useState<OssieModel | null>(null)
  const dirty = !!draft && !!base && !sameModel(draft, base.model)

  // Adopt the loaded document unless the user has unsaved edits.
  const [stale, setStale] = useState(false)
  if (doc.data && doc.data.etag !== base?.etag) {
    if (!dirty) {
      setBase({ etag: doc.data.etag, model: doc.data.model })
      setDraftState(doc.data.model)
      if (stale) setStale(false)
    } else if (!stale) {
      setStale(true)
    }
  }

  const setDraft = useCallback((f: (m: OssieModel) => OssieModel) => setDraftState((d) => (d ? f(d) : d)), [])
  const replaceDraft = useCallback((m: OssieModel) => setDraftState(m), [])
  const discard = useCallback(() => {
    setDraftState(base?.model ?? null)
  }, [base])

  // Live validation (schema, structure and catalog) of the draft, debounced.
  const [problems, setProblems] = useState<Problem[]>([])
  const [validating, setValidating] = useState(false)
  const seq = useRef(0)
  const draftJson = draft ? JSON.stringify(draft) : ''
  useEffect(() => {
    if (!draftJson) return
    const n = ++seq.current
    const t = window.setTimeout(async () => {
      setValidating(true)
      try {
        const ps = await ossie.validate(cluster, JSON.parse(draftJson) as OssieModel)
        if (n === seq.current) setProblems(ps)
      } catch {
        /* validation is advisory; saving re-validates */
      } finally {
        if (n === seq.current) setValidating(false)
      }
    }, 600)
    return () => window.clearTimeout(t)
  }, [draftJson, cluster])

  const save = useMutation({
    mutationFn: () => ossie.save(cluster, wh, ns, name, draft!, base!.etag),
    onSuccess: (r) => {
      qc.setQueryData<ModelDoc>(key, (old) => ({ ...(old as ModelDoc), model: r.model, etag: r.etag, versionId: r.versionId, problems: r.problems, raw: undefined }))
      setBase({ etag: r.etag, model: r.model })
      setDraftState(r.model)
      setStale(false)
      setProblems(r.problems)
      void qc.invalidateQueries({ queryKey: semanticKeys.list(cluster, wh, ns) })
      void qc.invalidateQueries({ queryKey: semanticKeys.versions(cluster, wh, ns, name) })
      void qc.invalidateQueries({ queryKey: semanticKeys.drift(cluster, wh, ns, name) })
      void qc.invalidateQueries({ queryKey: ['semantic', cluster, wh, 'usage'] })
    },
    onError: (e) => {
      if (e instanceof ModelError) setProblems(e.problems)
    },
  })

  const conflict = save.error instanceof ApiError && save.error.type === 'ModelConflict'

  /** Drops local edits and loads the latest saved version. */
  const reload = useCallback(async () => {
    save.reset()
    setBase(null)
    setDraftState(null)
    setStale(false)
    await qc.invalidateQueries({ queryKey: key })
  }, [qc, key, save])

  // Warn before leaving the page with unsaved edits.
  useEffect(() => {
    if (!dirty) return
    const h = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', h)
    return () => window.removeEventListener('beforeunload', h)
  }, [dirty])

  return { doc, base, draft, setDraft, replaceDraft, dirty, discard, problems, validating, save, conflict, stale, reload }
}

export type ModelEditor = ReturnType<typeof useModelEditor>
