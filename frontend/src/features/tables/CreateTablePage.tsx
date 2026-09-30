import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router'
import { Code, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { EntityBadgeIcon } from '@/components/ui/entity-icon'
import { Field, Input, Label } from '@/components/ui/input'
import { JsonView } from '@/components/ui/json-view'
import { Card, CardHeader, PageHeader } from '@/components/ui/layout'
import { InlineError } from '@/components/ui/states'
import { useToast } from '@/components/ui/toast'
import { createTable } from '@/lib/catalog'
import { cn } from '@/lib/cn'
import { assignPartitionFieldIds, type SpecFieldDraft } from '@/lib/commits'
import type { SortField } from '@/lib/iceberg'
import { decodeNamespaceParam, namespaceLabel } from '@/lib/namespace'
import { newField, toIcebergFields, validateFields } from '@/lib/schemaModel'
import { paths } from '@/layout/paths'
import { useCluster } from '@/layout/useCluster'
import { validateDrafts } from '@/features/namespaces/PropertiesEditor'
import { invalidateCluster } from '@/features/warehouses/WarehouseDialogs'
import { PartitionFieldsEditor, partitionProblems, SortFieldsEditor, sourceColumns } from './LayoutEditors'
import { SchemaEditor, type DraftField } from './SchemaEditor'

const NAME_RE = /^[a-z0-9_]{1,250}$/
const byteLen = (s: string) => new TextEncoder().encode(s).length
const FORBIDDEN_PROP = (k: string) =>
  k.startsWith('write.data.path') ||
  (k.startsWith('write.metadata.') && !['write.metadata.compression-codec', 'write.metadata.metrics.default', 'write.metadata.previous-versions-max', 'write.metadata.delete-after-commit.enabled'].includes(k))

function initialFields(): DraftField[] {
  const id = newField('id', { kind: 'primitive', name: 'long' })
  id.required = true
  return [id, newField('created_at', { kind: 'primitive', name: 'timestamptz' }), newField('payload', { kind: 'primitive', name: 'string' })]
}

/**
 * Create an Iceberg table: schema (with nested types), partition spec,
 * sort order, format version and properties. AIStor manages the location
 * and does not support column default values; both are enforced here and
 * again by the server.
 */
export function CreateTablePage() {
  const cluster = useCluster()
  const params = useParams()
  const wh = params.wh!
  const ns = useMemo(() => decodeNamespaceParam(params.ns), [params.ns])
  const navigate = useNavigate()
  const qc = useQueryClient()
  const toast = useToast()

  const [name, setName] = useState('')
  const [fields, setFields] = useState<DraftField[]>(initialFields)
  const [spec, setSpec] = useState<SpecFieldDraft[]>([])
  const [order, setOrder] = useState<SortField[]>([])
  const [formatVersion, setFormatVersion] = useState(2)
  const [props, setProps] = useState<{ id: number; key: string; value: string }[]>([
    { id: 1, key: 'write.format.default', value: 'parquet' },
    { id: 2, key: 'write.parquet.compression-codec', value: 'zstd' },
  ])
  const [showJson, setShowJson] = useState(false)
  const [touched, setTouched] = useState(false)

  const schemaProblems = validateFields(fields)
  const built = useMemo(() => toIcebergFields(fields, 1), [fields])
  const cols = useMemo(() => sourceColumns({ fields: built.fields }), [built])
  const specProblems = partitionProblems(spec, cols)
  const propProblem =
    validateDrafts(props.map((p) => ({ ...p, origKey: undefined }))) ??
    props.map((p) => (FORBIDDEN_PROP(p.key) ? `Property "${p.key}" is managed by AIStor or unsupported` : byteLen(p.value) > 2048 ? `Value of "${p.key}" exceeds 2 KB` : null)).find(Boolean) ??
    null
  const nameError = name && !NAME_RE.test(name) ? 'Use 1–250 lowercase letters, digits and underscores' : null
  const problems = [...(nameError ? [nameError] : []), ...(name ? [] : ['Table name is required']), ...schemaProblems.map((p) => p.message), ...specProblems, ...(propProblem ? [propProblem] : [])]

  const body = useMemo(() => {
    // Build against a synthetic metadata so partition field ids start at 1000.
    const specFields = assignPartitionFieldIds({ 'partition-specs': [], 'last-partition-id': 999 } as never, spec)
    const properties = Object.fromEntries(props.filter((p) => p.key).map((p) => [p.key, p.value]))
    properties['format-version'] = String(formatVersion)
    const b: Record<string, unknown> = {
      name,
      schema: { type: 'struct', 'schema-id': 0, fields: built.fields },
      'partition-spec': { 'spec-id': 0, fields: specFields },
      properties,
    }
    if (order.length) b['write-order'] = { 'order-id': 1, fields: order }
    return b
  }, [name, built, spec, order, props, formatVersion])

  const create = useMutation({
    mutationFn: () => createTable(cluster, wh, ns, body),
    onSuccess: () => {
      invalidateCluster(qc, cluster)
      toast.success('Table created', `${namespaceLabel(ns)}.${name}`)
      navigate(paths.table(cluster, wh, ns, name), { replace: true })
    },
  })

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<EntityBadgeIcon kind="table" />}
        title="Create table"
        subtitle={
          <span className="font-mono">
            {wh}.{namespaceLabel(ns)}
          </span>
        }
        actions={
          <Button variant="outline" onClick={() => setShowJson((v) => !v)} aria-pressed={showJson}>
            <Code /> {showJson ? 'Hide' : 'Show'} request
          </Button>
        }
      />

      <div className={cn('grid gap-5', showJson && 'xl:grid-cols-[minmax(0,1fr)_420px]')}>
        <div className="flex flex-col gap-5">
          <Card>
            <CardHeader title="Basics" />
            <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_220px]">
              <Field label="Table name" error={nameError} hint="Lowercase letters, digits and underscores. AIStor chooses the storage location.">
                {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} className="font-mono" placeholder="orders" autoFocus spellCheck={false} />}
              </Field>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="fv">Iceberg format version</Label>
                <select id="fv" value={formatVersion} onChange={(e) => setFormatVersion(Number(e.target.value))} className="h-8 rounded-[var(--radius-control)] border border-border bg-bg px-2 text-[13px]">
                  <option value={2}>v2 (widest engine support)</option>
                  <option value={3}>v3 (row lineage, new types)</option>
                </select>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader title="Schema" description="Nested structs, lists and maps are supported. Column default values are not supported by AIStor." />
            <div className="p-3">
              <SchemaEditor fields={fields} onChange={setFields} problems={touched ? schemaProblems : []} formatVersion={formatVersion} />
            </div>
          </Card>

          <div className="grid gap-5 xl:grid-cols-2">
            <Card>
              <CardHeader title="Partitioning" description="Hidden partitioning: queries filter on the column, not the partition." />
              <div className="p-4">
                <PartitionFieldsEditor cols={cols} value={spec} onChange={setSpec} />
              </div>
            </Card>
            <Card>
              <CardHeader title="Sort order" description="Optional clustering of rows within data files." />
              <div className="p-4">
                <SortFieldsEditor cols={cols} value={order} onChange={setOrder} />
              </div>
            </Card>
          </div>

          <Card>
            <CardHeader title="Properties" />
            <div className="flex flex-col gap-2 p-4">
              {props.map((p, i) => (
                <div key={p.id} className="flex items-center gap-2">
                  <Input aria-label="Property key" value={p.key} onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} className="font-mono text-[12px]" placeholder="key" />
                  <Input aria-label={`Value for ${p.key || 'property'}`} value={p.value} onChange={(e) => setProps((ps) => ps.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} className="font-mono text-[12px]" placeholder="value" />
                  <Button size="icon-sm" variant="ghost" aria-label="Remove property" onClick={() => setProps((ps) => ps.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
              <div>
                <Button size="sm" variant="ghost" onClick={() => setProps((ps) => [...ps, { id: Date.now(), key: '', value: '' }])}>
                  <Plus /> Add property
                </Button>
              </div>
            </div>
          </Card>
        </div>

        {showJson && (
          <Card className="self-start xl:sticky xl:top-4">
            <CardHeader title="CreateTable request" description="Sent to AIStor with your credentials" />
            <div className="max-h-[70vh] overflow-auto p-3">
              <JsonView value={body} defaultDepth={3} />
            </div>
          </Card>
        )}
      </div>

      <div className="sticky bottom-0 -mx-6 flex flex-col gap-2 border-t border-border bg-bg/95 px-6 py-3 backdrop-blur">
        {touched && problems.length > 0 && (
          <ul className="text-[12.5px] text-warning">
            {problems.slice(0, 4).map((p, i) => (
              <li key={i}>• {p}</li>
            ))}
            {problems.length > 4 && <li>• …and {problems.length - 4} more</li>}
          </ul>
        )}
        <InlineError error={create.error} />
        <div className="flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => navigate(-1)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTouched(true)
              if (problems.length === 0) create.mutate()
            }}
          >
            Create table
          </Button>
        </div>
      </div>
    </div>
  )
}
