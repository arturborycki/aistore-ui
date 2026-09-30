import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { AlertTriangle, Braces, Download, Ellipsis, FileCode2, GitBranch, History, Info, Network, RefreshCw, Save, Sigma, Table2, Trash2, Undo2 } from 'lucide-react'
import { useMe } from '@/auth/AuthContext'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { TypeToConfirmDialog } from '@/components/ui/confirm-dialog'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Field, Textarea } from '@/components/ui/input'
import { Card, CardHeader, KeyValue, PageHeader, StatCard } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState, InlineError } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/cn'
import { formatDateTime, formatRelative } from '@/lib/format'
import { decodeNamespaceParam } from '@/lib/namespace'
import { ossie, problemTarget, semanticKeys, SPEC_VERSION, type OssieModel, type Problem } from '@/lib/ossie'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { AIContextEditor } from './AIContextEditor'
import { DatasetsPanel } from './DatasetsPanel'
import { HistoryPanel } from './HistoryPanel'
import { MetricsPanel } from './MetricsPanel'
import { ProblemList } from './ProblemList'
import { RelationshipsPanel } from './RelationshipsPanel'
import { SyncPanel } from './SyncPanel'
import { useModelEditor } from './useModelEditor'
import { YamlPanel } from './YamlPanel'

function OverviewPanel({ model, setDraft, cluster, wh, ns, name, doc }: { model: OssieModel; setDraft: (f: (m: OssieModel) => OssieModel) => void; cluster: string; wh: string; ns: string[]; name: string; doc: { key: string; lastModified: string; editor?: string } }) {
  const me = useMe()
  const bucket = me.features?.semantic?.bucket
  const fields = model.datasets.reduce((n, d) => n + (d.fields?.length ?? 0), 0)
  const serving = me.features?.semantic?.serving
  const apiPath = `/ossie/v1/models/${encodeURIComponent(cluster)}/${encodeURIComponent(wh)}/${ns.map(encodeURIComponent).join('.')}/${encodeURIComponent(name)}`
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Datasets" value={model.datasets.length} />
        <StatCard label="Fields" value={fields} />
        <StatCard label="Relationships" value={model.relationships?.length ?? 0} />
        <StatCard label="Metrics" value={model.metrics?.length ?? 0} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader title="About this model" />
          <div className="flex flex-col gap-3 p-4">
            <Field label="Description">
              {(p) => <Textarea {...p} rows={3} value={model.description ?? ''} onChange={(e) => setDraft((m) => ({ ...m, description: e.target.value || undefined }))} placeholder="What questions does this model answer?" />}
            </Field>
            <AIContextEditor subject="this model" value={model.ai_context} onChange={(v) => setDraft((m) => ({ ...m, ai_context: v }))} />
          </div>
        </Card>
        <Card className="self-start">
          <CardHeader title="File" />
          <div className="p-4">
            <KeyValue
              items={[
                { label: 'Object', value: <CopyText value={`s3://${bucket}/${doc.key}`} /> },
                { label: 'Specification', value: `Apache Ossie ${SPEC_VERSION}` },
                { label: 'Last saved', value: <span title={formatDateTime(doc.lastModified)}>{formatRelative(doc.lastModified)}{doc.editor ? ` by ${doc.editor}` : ''}</span> },
                ...(serving ? [{ label: 'Read API', value: <CopyText value={apiPath} /> }] : []),
              ]}
            />
            <div className="mt-3 flex flex-wrap gap-2">
              <a className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2.5 text-[12px] hover:bg-surface" href={ossie.yamlUrl(cluster, wh, ns, name)} download>
                <Download className="size-3.5" /> YAML
              </a>
              <a className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-control)] border border-border px-2.5 text-[12px] hover:bg-surface" href={ossie.jsonUrl(cluster, wh, ns, name)} download>
                <Braces className="size-3.5" /> JSON
              </a>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}

/** The stored file is not a valid model: offer to repair the YAML. */
function RepairPanel({ raw, problems, onRepaired }: { raw: string; problems: Problem[]; onRepaired: (m: OssieModel) => void }) {
  const cluster = useCluster()
  const [text, setText] = useState(raw)
  const parse = useMutation({ mutationFn: () => ossie.parse(cluster, text), onSuccess: (r) => r.model && !r.problems.some((p) => p.severity === 'error') && onRepaired(r.model) })
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><AlertTriangle className="size-4 text-danger" /> The stored file is not a valid Ossie model</span>} description="It was probably edited outside this UI. Fix the YAML, check it, then save." />
      <div className="flex flex-col gap-3 p-4">
        <ProblemList problems={parse.data?.problems ?? problems} />
        <Textarea aria-label="Model YAML" rows={22} value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} className="font-mono text-[12px]" />
        <InlineError error={parse.error} />
        <div className="flex justify-end">
          <Button variant="primary" loading={parse.isPending} onClick={() => parse.mutate()}>
            Check and load into the editor
          </Button>
        </div>
      </div>
    </Card>
  )
}

export function ModelPage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const name = params.model!
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'overview'
  const setTab = (t: string) => setSearch({ tab: t }, { replace: true })
  const navigate = useNavigate()
  const toast = useToast()
  const qc = useQueryClient()
  const ed = useModelEditor(cluster, wh, ns, name)
  const [dsSel, setDsSel] = useState(0)
  const [mtSel, setMtSel] = useState(0)
  const [deleting, setDeleting] = useState(false)
  const drift = useQuery({ queryKey: semanticKeys.drift(cluster, wh, ns, name), queryFn: () => ossie.drift(cluster, wh, ns, name), enabled: !!ed.doc.data?.model, staleTime: 60_000 })
  const remove = useMutation({
    mutationFn: () => ossie.remove(cluster, wh, ns, name, ed.base!.etag),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: semanticKeys.list(cluster, wh, ns) })
      toast.success(`Deleted model ${name}`)
      navigate(`${paths.namespace(cluster, wh, ns)}?tab=semantic`, { replace: true })
    },
  })

  const model = ed.draft
  const errors = ed.problems.filter((p) => p.severity === 'error')
  const goTo = (p: Problem) => {
    const t = problemTarget(p.path)
    if (t.tab === 'datasets' && t.index != null) setDsSel(t.index)
    if (t.tab === 'metrics' && t.index != null) setMtSel(t.index)
    setTab(t.tab)
  }

  const header = (
    <PageHeader
      icon={<EntityBadgeIcon kind="model" />}
      title={<span className="font-mono">{name}</span>}
      subtitle={<span>Semantic model in <span className="font-mono">{wh}.{ns.join('.')}</span></span>}
      badges={
        <>
          <Badge tone="accent">Ossie {SPEC_VERSION}</Badge>
          {drift.data && drift.data.items.length > 0 && (
            <button type="button" onClick={() => setTab('sync')}>
              <Badge tone="warning">
                <RefreshCw className="size-3" /> {drift.data.items.length} catalog change{drift.data.items.length === 1 ? '' : 's'}
              </Badge>
            </button>
          )}
          {ed.dirty && <Badge tone="info">Unsaved changes</Badge>}
        </>
      }
      actions={
        <Menu>
          <MenuTrigger asChild>
            <Button size="icon" variant="outline" aria-label="Model actions">
              <Ellipsis />
            </Button>
          </MenuTrigger>
          <MenuContent>
            <MenuItem icon={<Download />} onSelect={() => window.location.assign(ossie.yamlUrl(cluster, wh, ns, name))}>
              Download YAML
            </MenuItem>
            <MenuItem icon={<Braces />} onSelect={() => window.location.assign(ossie.jsonUrl(cluster, wh, ns, name))}>
              Download JSON
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} danger onSelect={() => setDeleting(true)}>
              Delete model…
            </MenuItem>
          </MenuContent>
        </Menu>
      }
    />
  )

  if (ed.doc.isError) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <ErrorState error={ed.doc.error} onRetry={() => ed.doc.refetch()} />
      </div>
    )
  }
  if (ed.doc.isPending) {
    return (
      <div className="flex flex-col gap-5">
        {header}
        <Skeleton className="h-80" />
      </div>
    )
  }
  const doc = ed.doc.data

  return (
    <div className="flex flex-col gap-5 pb-20">
      {header}
      {ed.stale && (
        <div role="status" className="flex flex-wrap items-center gap-2 rounded-[var(--radius-card)] border border-warning/40 bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">
          <AlertTriangle className="size-4" /> Someone saved a newer version while you were editing. Saving now will be rejected.
          <Button size="sm" variant="outline" className="ml-auto" onClick={() => void ed.reload()}>
            Load the newer version (discard mine)
          </Button>
        </div>
      )}
      {!model ? (
        <RepairPanel raw={doc.raw ?? ''} problems={doc.problems} onRepaired={(m) => ed.replaceDraft({ ...m, name })} />
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList className="overflow-x-auto">
            <TabsTrigger value="overview" icon={<Info />}>Overview</TabsTrigger>
            <TabsTrigger value="datasets" icon={<Table2 />} count={model.datasets.length}>Datasets</TabsTrigger>
            <TabsTrigger value="relationships" icon={<Network />} count={model.relationships?.length ?? 0}>Relationships</TabsTrigger>
            <TabsTrigger value="metrics" icon={<Sigma />} count={model.metrics?.length ?? 0}>Metrics</TabsTrigger>
            <TabsTrigger value="yaml" icon={<FileCode2 />}>YAML</TabsTrigger>
            <TabsTrigger value="history" icon={<History />}>History</TabsTrigger>
            <TabsTrigger value="sync" icon={<GitBranch />} count={drift.data?.items.length}>Catalog sync</TabsTrigger>
          </TabsList>
          <TabsContent value="overview">
            <OverviewPanel model={model} setDraft={ed.setDraft} cluster={cluster} wh={wh} ns={ns} name={name} doc={doc} />
          </TabsContent>
          <TabsContent value="datasets">
            <DatasetsPanel cluster={cluster} wh={wh} ns={ns} model={model} setDraft={ed.setDraft} problems={ed.problems} selected={dsSel} onSelect={setDsSel} />
          </TabsContent>
          <TabsContent value="relationships">
            <RelationshipsPanel model={model} setDraft={ed.setDraft} problems={ed.problems} />
          </TabsContent>
          <TabsContent value="metrics">
            <MetricsPanel model={model} setDraft={ed.setDraft} problems={ed.problems} selected={mtSel} onSelect={setMtSel} />
          </TabsContent>
          <TabsContent value="yaml">
            <YamlPanel cluster={cluster} wh={wh} ns={ns} name={name} draft={model} dirty={ed.dirty} onApply={(m) => ed.replaceDraft({ ...m, name })} />
          </TabsContent>
          <TabsContent value="history">
            <HistoryPanel
              cluster={cluster}
              wh={wh}
              ns={ns}
              name={name}
              onRestore={(m) => {
                ed.replaceDraft({ ...m, name })
                toast.info('Version restored into the draft', 'Review it, then save to make it current.')
                setTab('yaml')
              }}
            />
          </TabsContent>
          <TabsContent value="sync">
            <SyncPanel
              cluster={cluster}
              wh={wh}
              ns={ns}
              name={name}
              dirty={ed.dirty}
              onFixed={(m) => {
                ed.replaceDraft(m)
                toast.info('Fixes applied to the draft', 'Review the changes, then save.')
                setTab('yaml')
              }}
            />
          </TabsContent>
        </Tabs>
      )}

      {(ed.dirty || ed.save.isError) && model && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-bg/95 px-4 py-2.5 shadow-pop backdrop-blur md:left-auto md:right-6 md:bottom-4 md:max-w-3xl md:rounded-[var(--radius-card)] md:border">
          {ed.conflict ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px]">
              <AlertTriangle className="size-4 text-danger" />
              <span className="mr-auto">Someone else saved this model since you opened it. Your changes were not saved.</span>
              <Button size="sm" variant="outline" onClick={() => setTab('yaml')}>
                Review my changes
              </Button>
              <Button size="sm" variant="danger" onClick={() => void ed.reload()}>
                Discard mine and reload
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {ed.save.isError && !(ed.save.error as { problems?: unknown }).problems && <InlineError error={ed.save.error} />}
              {errors.length > 0 && <ProblemList problems={errors} title={`${errors.length} error${errors.length === 1 ? '' : 's'} to fix before saving`} onSelect={goTo} className="max-h-40" />}
              <div className="flex flex-wrap items-center gap-2">
                <span className={cn('mr-auto text-[12.5px]', ed.validating ? 'text-muted' : errors.length ? 'text-danger' : 'text-muted')}>
                  {ed.validating ? 'Checking…' : errors.length ? 'Fix the errors to save' : `Unsaved changes${ed.problems.length ? ` · ${ed.problems.length} warning${ed.problems.length === 1 ? '' : 's'}` : ''}`}
                </span>
                {ed.problems.some((p) => p.severity === 'warning') && !errors.length && (
                  <Button size="sm" variant="ghost" onClick={() => setTab('yaml')}>
                    Review
                  </Button>
                )}
                <Button size="sm" variant="ghost" onClick={ed.discard} disabled={ed.save.isPending}>
                  <Undo2 /> Discard
                </Button>
                <Button
                  size="sm"
                  variant="primary"
                  disabled={!ed.dirty || errors.length > 0}
                  loading={ed.save.isPending}
                  onClick={() =>
                    ed.save.mutate(undefined, {
                      onSuccess: (r) => toast.success(`Saved ${name}`, r.problems.length ? `${r.problems.length} warning(s)` : undefined),
                    })
                  }
                >
                  <Save /> Save model
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <TypeToConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete semantic model ${name}?`}
        consequence="The model file is deleted. With bucket versioning, earlier versions remain recoverable by an administrator. Tables are not affected."
        confirmText={name}
        actionLabel="Delete model"
        onConfirm={() => remove.mutate()}
        pending={remove.isPending}
        error={remove.error}
      />
    </div>
  )
}
