import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Lock, Pencil, Plus, RotateCcw, Tag, Wrench, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Label } from '@/components/ui/input'
import { Card, CardHeader, KeyValue } from '@/components/ui/layout'
import { Skeleton } from '@/components/ui/skeleton'
import { ErrorState, InlineError } from '@/components/ui/states'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/toast'
import { ApiError } from '@/lib/api'
import type { EncryptionConfig, MaintenanceType, MaintenanceValue } from '@/lib/catalog'
import { cn } from '@/lib/cn'

const notFound = (e: unknown) => e instanceof ApiError && e.isNotFound

// ---------------------------------------------------------------- encryption

/**
 * Server-side encryption settings. `onRemove` is offered only where AIStor
 * supports removing the configuration (warehouse defaults).
 */
export function EncryptionCard({
  queryKey,
  load,
  save,
  onRemove,
  scope,
}: {
  queryKey: readonly unknown[]
  load: () => Promise<Record<string, unknown>>
  save: (c: EncryptionConfig) => Promise<void>
  onRemove?: () => Promise<void>
  scope: 'warehouse' | 'table'
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey, queryFn: load })
  const current = ((q.data?.encryptionConfiguration ?? q.data) ?? null) as EncryptionConfig | null
  const [editing, setEditing] = useState(false)
  const [algo, setAlgo] = useState<EncryptionConfig['sseAlgorithm']>('AES256')
  const [key, setKey] = useState('')
  useEffect(() => {
    if (editing) {
      setAlgo(current?.sseAlgorithm ?? 'AES256')
      setKey(current?.kmsKeyArn ?? '')
    }
  }, [editing, current?.sseAlgorithm, current?.kmsKeyArn])
  const m = useMutation({
    mutationFn: () => save(algo === 'aws:kms' ? { sseAlgorithm: algo, kmsKeyArn: key.trim() } : { sseAlgorithm: algo }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey })
      toast.success('Encryption updated', scope === 'warehouse' ? 'Applies to tables created from now on.' : 'Applies to newly written files.')
      setEditing(false)
    },
  })
  const rm = useMutation({
    mutationFn: () => onRemove!(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey })
      toast.success('Default encryption removed')
    },
  })
  return (
    <Card>
      <CardHeader
        title={<span className="flex items-center gap-2"><Lock className="size-4 text-muted" />Encryption</span>}
        description={scope === 'warehouse' ? 'Default server-side encryption for new tables.' : "Server-side encryption for this table's files."}
        actions={
          !editing && (
            <Button size="sm" variant="outline" aria-label="Edit encryption" onClick={() => setEditing(true)} disabled={q.isPending}>
              <Pencil /> Edit
            </Button>
          )
        }
      />
      <div className="p-4">
        {q.isPending ? (
          <Skeleton className="h-12" />
        ) : q.isError && !notFound(q.error) ? (
          <ErrorState error={q.error} compact />
        ) : editing ? (
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate() }}>
            <div className="flex flex-col gap-2">
              {(['AES256', 'aws:kms'] as const).map((a) => (
                <label key={a} className={cn('flex cursor-pointer items-start gap-2 rounded-[var(--radius-control)] border p-2.5 text-[12.5px]', algo === a ? 'border-accent bg-accent-subtle/40' : 'border-border')}>
                  <input type="radio" name={`sse-${scope}`} checked={algo === a} onChange={() => setAlgo(a)} className="mt-0.5 accent-[var(--accent)]" />
                  <span>
                    <span className="font-mono font-medium">{a}</span>
                    <span className="block text-muted">{a === 'AES256' ? 'Keys managed by AIStor (SSE-S3).' : 'Keys from the configured KMS (SSE-KMS).'}</span>
                  </span>
                </label>
              ))}
            </div>
            {algo === 'aws:kms' && (
              <Field label="KMS key" hint="Key name or ARN as configured in AIStor's KMS.">
                {(p) => <Input {...p} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-[12px]" required />}
              </Field>
            )}
            <InlineError error={m.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setEditing(false); m.reset() }}>Cancel</Button>
              <Button type="submit" variant="primary" loading={m.isPending} disabled={algo === 'aws:kms' && !key.trim()}>Save</Button>
            </div>
          </form>
        ) : !current?.sseAlgorithm ? (
          <p className="text-[12.5px] text-subtle">{scope === 'warehouse' ? 'No default encryption configured.' : 'No table-level encryption; the warehouse default applies.'}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <KeyValue
              items={[
                { label: 'Algorithm', value: <Badge tone="success"><Lock className="size-3" />{current.sseAlgorithm}</Badge> },
                ...(current.kmsKeyArn ? [{ label: 'KMS key', value: <span className="break-all font-mono text-[12px]">{current.kmsKeyArn}</span> }] : []),
              ]}
            />
            {onRemove && (
              <div>
                <Button size="sm" variant="danger-outline" loading={rm.isPending} onClick={() => rm.mutate()}>
                  Remove default encryption
                </Button>
                <InlineError error={rm.error} />
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- tags

const TAG_KEY = /^[\p{L}\p{N}\s_.:/=+\-@]{1,128}$/u
const TAG_VALUE = /^[\p{L}\p{N}\s_.:/=+\-@]{0,256}$/u

export function TagsCard({
  queryKey,
  load,
  add,
  remove,
  description,
}: {
  queryKey: readonly unknown[]
  load: () => Promise<Record<string, unknown>>
  add: (tags: Record<string, string>) => Promise<void>
  remove: (keys: string[]) => Promise<void>
  description: string
}) {
  const qc = useQueryClient()
  const toast = useToast()
  const q = useQuery({ queryKey, queryFn: load })
  const tags = ((q.data?.tags ?? q.data) ?? {}) as Record<string, string>
  const [k, setK] = useState('')
  const [v, setV] = useState('')
  const addM = useMutation({
    mutationFn: () => add({ [k.trim()]: v.trim() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey })
      toast.success('Tag saved', `${k.trim()}=${v.trim()}`)
      setK('')
      setV('')
    },
  })
  const rmM = useMutation({
    mutationFn: (key: string) => remove([key]),
    onSuccess: (_d, key) => {
      void qc.invalidateQueries({ queryKey })
      toast.success('Tag removed', key)
    },
  })
  const keyErr = k && !TAG_KEY.test(k.trim()) ? 'Invalid key' : null
  const valErr = v && !TAG_VALUE.test(v.trim()) ? 'Invalid value' : null
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2"><Tag className="size-4 text-muted" />Tags</span>} description={description} />
      <div className="flex flex-col gap-3 p-4">
        {q.isPending ? (
          <Skeleton className="h-8" />
        ) : q.isError && !notFound(q.error) ? (
          <ErrorState error={q.error} compact />
        ) : Object.keys(tags).length === 0 ? (
          <p className="text-[12.5px] text-subtle">No tags.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(tags)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => (
                <span key={key} className="inline-flex h-6 items-center overflow-hidden rounded-full border border-border text-[12px]">
                  <span className="bg-surface px-2 font-mono text-muted">{key}</span>
                  <span className="px-2 font-mono">{String(val)}</span>
                  <button type="button" aria-label={`Remove tag ${key}`} className="pr-1.5 text-subtle hover:text-danger disabled:opacity-40" disabled={rmM.isPending} onClick={() => rmM.mutate(key)}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
          </div>
        )}
        <form className="flex items-start gap-2" onSubmit={(e) => { e.preventDefault(); if (k.trim() && !keyErr && !valErr) addM.mutate() }}>
          <Input aria-label="Tag key" aria-invalid={!!keyErr} value={k} onChange={(e) => setK(e.target.value)} placeholder="key" className="font-mono text-[12px]" />
          <Input aria-label="Tag value" aria-invalid={!!valErr} value={v} onChange={(e) => setV(e.target.value)} placeholder="value" className="font-mono text-[12px]" />
          <Button type="submit" variant="outline" disabled={!k.trim() || !!keyErr || !!valErr} loading={addM.isPending}>
            <Plus /> Add
          </Button>
        </form>
        <InlineError error={addM.error ?? rmM.error} />
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------- maintenance

export const MAINTENANCE_SETTINGS: Record<MaintenanceType, { title: string; description: string; fields: { key: string; label: string; min: number; max?: number; unit: string }[] }> = {
  icebergCompaction: {
    title: 'Compaction',
    description: 'Rewrites small data files into larger ones.',
    fields: [{ key: 'targetFileSizeMB', label: 'Target file size', min: 16, max: 10240, unit: 'MB' }],
  },
  icebergSnapshotManagement: {
    title: 'Snapshot expiration',
    description: 'Expires old snapshots by age while keeping a minimum number.',
    fields: [
      { key: 'minSnapshotsToKeep', label: 'Minimum snapshots to keep', min: 1, unit: 'snapshots' },
      { key: 'maxSnapshotAgeHours', label: 'Maximum snapshot age', min: 1, unit: 'hours' },
    ],
  },
  icebergUnreferencedFileRemoval: {
    title: 'Unreferenced file removal',
    description: 'Deletes files no snapshot references any more.',
    fields: [
      { key: 'unreferencedDays', label: 'Delete unreferenced files after', min: 1, unit: 'days' },
      { key: 'nonCurrentDays', label: 'Delete non-current versions after', min: 1, unit: 'days' },
    ],
  },
}

type MaintConfig = Partial<Record<MaintenanceType, { status?: string; settings?: Record<string, Record<string, number>> }>>

function MaintenanceTypeEditor({
  type,
  current,
  inherited,
  onSave,
  onReset,
  inheritedText,
}: {
  inheritedText: string
  type: MaintenanceType
  current?: { status?: string; settings?: Record<string, Record<string, number>> }
  inherited: boolean
  onSave: (v: MaintenanceValue) => Promise<void>
  onReset?: () => Promise<void>
}) {
  const spec = MAINTENANCE_SETTINGS[type]
  const qcSettings = current?.settings?.[type] ?? {}
  const [enabled, setEnabled] = useState(current?.status !== 'disabled')
  const [values, setValues] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState(false)
  const toast = useToast()
  useEffect(() => {
    if (!editing) {
      setEnabled(current?.status !== 'disabled')
      setValues(Object.fromEntries(spec.fields.map((f) => [f.key, qcSettings[f.key] != null ? String(qcSettings[f.key]) : ''])))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, JSON.stringify(current)])
  const problems = spec.fields.flatMap((f) => {
    const v = values[f.key]
    if (!enabled || v === '' || v == null) return []
    const n = Number(v)
    return !Number.isInteger(n) || n < f.min || (f.max != null && n > f.max) ? [`${f.label}: ${f.min}${f.max ? `–${f.max}` : '+'} ${f.unit}`] : []
  })
  const save = useMutation({
    mutationFn: () => {
      const settings = Object.fromEntries(spec.fields.filter((f) => values[f.key] !== '').map((f) => [f.key, Number(values[f.key])]))
      return onSave(enabled ? { status: 'enabled', settings: { [type]: settings } } : { status: 'disabled' })
    },
    onSuccess: () => {
      toast.success(`${spec.title} updated`)
      setEditing(false)
    },
  })
  const reset = useMutation({
    mutationFn: () => onReset!(),
    onSuccess: () => toast.success(`${spec.title} reset`, 'Now inherits the warehouse default.'),
  })
  return (
    <Card>
      <CardHeader
        title={spec.title}
        description={spec.description}
        actions={
          !editing ? (
            <Button size="sm" variant="outline" aria-label={`Edit ${spec.title}`} onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          ) : undefined
        }
      />
      <div className="flex flex-col gap-3 p-4">
        {!editing ? (
          inherited ? (
            <p className="text-[12.5px] text-subtle">{inheritedText}</p>
          ) : (
            <KeyValue
              items={[
                { label: 'Status', value: <Badge tone={current?.status === 'disabled' ? 'neutral' : 'success'}>{current?.status ?? 'enabled'}</Badge> },
                ...spec.fields.map((f) => ({ label: f.label, value: qcSettings[f.key] != null ? <span className="font-mono text-[12px]">{qcSettings[f.key]} {f.unit}</span> : <span className="text-subtle">default</span> })),
              ]}
            />
          )
        ) : (
          <>
            <label className="flex items-center gap-2 text-[12.5px]">
              <Switch checked={enabled} onCheckedChange={setEnabled} />
              {enabled ? 'Enabled' : 'Disabled'}
            </label>
            {enabled &&
              spec.fields.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <Label htmlFor={`${type}-${f.key}`} className="w-48 font-normal text-muted">
                    {f.label}
                  </Label>
                  <Input
                    id={`${type}-${f.key}`}
                    type="number"
                    min={f.min}
                    max={f.max}
                    value={values[f.key] ?? ''}
                    placeholder="default"
                    onChange={(e) => setValues((vs) => ({ ...vs, [f.key]: e.target.value }))}
                    className="w-28 font-mono"
                  />
                  <span className="text-[12px] text-muted">{f.unit}</span>
                </div>
              ))}
            {problems.length > 0 && <p className="text-[12px] text-warning">{problems.join(' · ')}</p>}
            <InlineError error={save.error} />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => { setEditing(false); save.reset() }}>Cancel</Button>
              <Button variant="primary" disabled={problems.length > 0} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            </div>
          </>
        )}
        {!editing && onReset && !inherited && (
          <div>
            <Button size="sm" variant="ghost" loading={reset.isPending} onClick={() => reset.mutate()}>
              <RotateCcw /> Use warehouse default
            </Button>
            <InlineError error={reset.error} />
          </div>
        )}
      </div>
    </Card>
  )
}

/** Maintenance configuration for a table or warehouse (per job type). */
export function MaintenanceSettings({
  queryKey,
  load,
  save,
  reset,
  types,
}: {
  queryKey: readonly unknown[]
  load: () => Promise<Record<string, unknown>>
  save: (type: MaintenanceType, v: MaintenanceValue) => Promise<void>
  reset?: (type: MaintenanceType) => Promise<void>
  types: MaintenanceType[]
}) {
  const qc = useQueryClient()
  const q = useQuery({ queryKey, queryFn: load })
  const cfg = ((q.data?.configuration ?? q.data) ?? {}) as MaintConfig
  const refresh = () => qc.invalidateQueries({ queryKey })
  if (q.isPending) return <Skeleton className="h-40" />
  if (q.isError && !notFound(q.error)) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {types.map((t) => (
        <MaintenanceTypeEditor
          key={t}
          type={t}
          current={cfg[t]}
          inherited={!cfg[t]}
          inheritedText={reset ? 'Inherits the warehouse default.' : 'Not configured; AIStor defaults apply.'}
          onSave={async (v) => {
            await save(t, v)
            await refresh()
          }}
          onReset={
            reset
              ? async () => {
                  await reset(t)
                  await refresh()
                }
              : undefined
          }
        />
      ))}
    </div>
  )
}

export function MaintenanceIcon() {
  return <Wrench className="size-4 text-muted" />
}
