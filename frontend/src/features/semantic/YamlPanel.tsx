import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, Download, FileCode2, GitCompare, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { DiffView } from '@/components/ui/diff-view'
import { Textarea } from '@/components/ui/input'
import { Card, CardHeader } from '@/components/ui/layout'
import { InlineError } from '@/components/ui/states'
import type { Namespace } from '@/lib/namespace'
import { ossie, type OssieModel } from '@/lib/ossie'
import { ProblemList } from './ProblemList'

function useDebounced<T>(v: T, ms: number) {
  const [x, setX] = useState(v)
  useEffect(() => {
    const t = window.setTimeout(() => setX(v), ms)
    return () => window.clearTimeout(t)
  }, [v, ms])
  return x
}

/**
 * The model as it will be stored (canonical YAML rendered by the server),
 * a diff against the saved version, and a raw YAML editor.
 */
export function YamlPanel({
  cluster,
  wh,
  ns,
  name,
  draft,
  dirty,
  savedRaw,
  onApply,
}: {
  cluster: string
  wh: string
  ns: Namespace
  name: string
  draft: OssieModel | null
  dirty: boolean
  savedRaw?: string
  onApply: (m: OssieModel) => void
}) {
  const json = useDebounced(draft ? JSON.stringify(draft) : '', 300)
  const rendered = useQuery({ queryKey: ['semantic-render', cluster, json], queryFn: ({ signal }) => ossie.render(cluster, JSON.parse(json) as OssieModel, signal), enabled: !!json, staleTime: Infinity })
  const saved = useQuery({ queryKey: ['semantic-yaml', cluster, wh, ns.join('\u001f'), name, 'latest'], queryFn: () => ossie.yaml(cluster, wh, ns, name), enabled: !savedRaw })
  const [mode, setMode] = useState<'view' | 'diff' | 'edit'>(dirty ? 'diff' : 'view')
  const [text, setText] = useState('')
  const parse = useMutation({
    mutationFn: () => ossie.parse(cluster, text),
    onSuccess: (r) => {
      if (r.model && !r.problems.some((p) => p.severity === 'error')) {
        onApply(r.model)
        setMode('diff')
      }
    },
  })
  const current = rendered.data ?? ''
  const before = savedRaw ?? saved.data ?? ''
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><FileCode2 className="size-4" /> {dirty ? 'Draft YAML' : 'YAML'}</span>}
        description="Canonical Apache Ossie YAML, exactly as it will be stored. Other tools can read the file directly from the bucket."
        actions={
          <div className="flex items-center gap-1.5">
            {mode !== 'edit' && (
              <>
                <Button size="sm" variant={mode === 'view' ? 'secondary' : 'ghost'} aria-pressed={mode === 'view'} onClick={() => setMode('view')}>
                  YAML
                </Button>
                <Button size="sm" variant={mode === 'diff' ? 'secondary' : 'ghost'} aria-pressed={mode === 'diff'} onClick={() => setMode('diff')}>
                  <GitCompare /> Changes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setText(current)
                    parse.reset()
                    setMode('edit')
                  }}
                >
                  <Pencil /> Edit YAML
                </Button>
                <CopyButton value={current} label="Copy YAML" />
                <a className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-control)] px-2 text-[12px] text-muted hover:bg-surface hover:text-fg" href={ossie.yamlUrl(cluster, wh, ns, name)} download>
                  <Download className="size-3.5" /> Saved file
                </a>
              </>
            )}
          </div>
        }
      />
      {mode === 'edit' ? (
        <div className="flex flex-col gap-3 p-4">
          <Textarea aria-label="Model YAML" value={text} onChange={(e) => setText(e.target.value)} rows={24} spellCheck={false} className="font-mono text-[12px]" />
          {parse.data && <ProblemList problems={parse.data.problems} title={parse.data.problems.some((p) => p.severity === 'error') ? 'The YAML was not applied' : 'Applied with warnings'} />}
          <InlineError error={parse.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setMode('view')}>
              Cancel
            </Button>
            <Button variant="primary" loading={parse.isPending} onClick={() => parse.mutate()}>
              <Check /> Apply to draft
            </Button>
          </div>
        </div>
      ) : mode === 'diff' ? (
        <DiffView before={before} after={current} label="Changes since the saved version" className="max-h-[65vh]" />
      ) : (
        <pre aria-label="Model YAML" tabIndex={0} className="max-h-[65vh] overflow-auto px-4 py-3 font-mono text-[12px] leading-5">
          {current}
        </pre>
      )}
      {rendered.isError && <div className="p-4"><InlineError error={rendered.error} /></div>}
    </Card>
  )
}
