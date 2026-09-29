import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams, useSearchParams } from 'react-router'
import { Ellipsis, Eye, FolderTree, KeyRound, SlidersHorizontal, Table2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { Menu, MenuContent, MenuItem, MenuTrigger } from '@/components/ui/dropdown'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Card, CardHeader, PageHeader } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState } from '@/components/ui/states'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useToast } from '@/components/ui/toast'
import { getNamespace, updateNamespaceProperties } from '@/lib/catalog'
import { decodeNamespaceParam, namespaceLabel, parentOf } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { AccessPanel } from '@/features/warehouses/AccessPanel'
import { DeleteNamespaceDialog } from './NamespaceDialogs'
import { NamespacesTable } from './NamespacesTable'
import { TablesList, ViewsList } from '@/features/tables/TablesList'
import { PropertiesEditor } from './PropertiesEditor'

export function NamespacePage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = decodeNamespaceParam(params.ns)
  const [search, setSearch] = useSearchParams()
  const tab = search.get('tab') ?? 'tables'
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()
  const [deleting, setDeleting] = useState(false)

  const q = useQuery({ queryKey: qk.namespace(cluster, wh, ns), queryFn: () => getNamespace(cluster, wh, ns) })
  const save = useMutation({
    mutationFn: (c: { updates: Record<string, string>; removals: string[] }) => updateNamespaceProperties(cluster, wh, ns, c.updates, c.removals),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: qk.namespace(cluster, wh, ns) })
      const missing = r?.missing ?? []
      toast.success(
        'Properties saved',
        [r?.updated?.length ? `${r.updated.length} set` : '', r?.removed?.length ? `${r.removed.length} removed` : '', missing.length ? `${missing.length} already absent` : '']
          .filter(Boolean)
          .join(' · ') || undefined,
      )
    },
  })

  const props = q.data?.properties ?? {}
  const propCount = Object.keys(props).length

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<EntityBadgeIcon kind="namespace" />}
        title={<span className="font-mono">{ns[ns.length - 1]}</span>}
        subtitle={
          <span className="font-mono">
            {wh}.{namespaceLabel(ns)}
          </span>
        }
        badges={ns.length > 1 && <Badge>Level {ns.length}</Badge>}
        actions={
          <Menu>
            <MenuTrigger asChild>
              <Button size="icon" variant="outline" aria-label="Namespace actions">
                <Ellipsis />
              </Button>
            </MenuTrigger>
            <MenuContent>
              <MenuItem icon={<Trash2 />} danger onSelect={() => setDeleting(true)}>
                Delete namespace…
              </MenuItem>
            </MenuContent>
          </Menu>
        }
      />

      {q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <Tabs value={tab} onValueChange={(v) => setSearch({ tab: v }, { replace: true })}>
          <TabsList>
            <TabsTrigger value="tables" icon={<Table2 />}>
              Tables
            </TabsTrigger>
            <TabsTrigger value="views" icon={<Eye />}>
              Views
            </TabsTrigger>
            <TabsTrigger value="namespaces" icon={<FolderTree />}>
              Child namespaces
            </TabsTrigger>
            <TabsTrigger value="properties" icon={<SlidersHorizontal />} count={q.isSuccess ? propCount : undefined}>
              Properties
            </TabsTrigger>
            <TabsTrigger value="access" icon={<KeyRound />}>
              Access
            </TabsTrigger>
          </TabsList>
          <TabsContent value="tables">
            <TablesList cluster={cluster} wh={wh} ns={ns} />
          </TabsContent>
          <TabsContent value="views">
            <ViewsList cluster={cluster} wh={wh} ns={ns} />
          </TabsContent>
          <TabsContent value="namespaces">
            <NamespacesTable cluster={cluster} warehouse={wh} parent={ns} />
          </TabsContent>
          <TabsContent value="properties">
            <Card>
              <CardHeader title="Namespace properties" description="Changes are applied atomically when you save." />
              <div className="p-4">
                {q.isPending ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <PropertiesEditor properties={props} onSave={(c) => save.mutate(c)} saving={save.isPending} error={save.error} />
                )}
              </div>
            </Card>
          </TabsContent>
          <TabsContent value="access">
            <AccessPanel warehouse={wh} namespace={ns} />
          </TabsContent>
        </Tabs>
      )}

      <div className="text-[12px] text-subtle">
        Identifier <CopyText value={[wh, ...ns].join('.')} />
      </div>

      <DeleteNamespaceDialog
        cluster={cluster}
        warehouse={wh}
        ns={ns}
        open={deleting}
        onOpenChange={setDeleting}
        onDeleted={() => {
          const parent = parentOf(ns)
          navigate(parent.length ? paths.namespace(cluster, wh, parent) : paths.warehouse(cluster, wh), { replace: true })
        }}
      />
    </div>
  )
}
