import { useState } from 'react'
import { Info } from 'lucide-react'
import { Card, CardHeader } from '@/components/ui/layout'
import { CopyButton, CopyText } from '@/components/ui/copy-button'
import { cn } from '@/lib/cn'
import { arn, resourceArn } from '@/lib/catalog'
import type { Namespace } from '@/lib/namespace'

const READ = ['s3tables:GetWarehouse', 's3tables:ListNamespaces', 's3tables:GetNamespace', 's3tables:ListTables', 's3tables:GetTable', 's3tables:GetTableData', 's3tables:GetTableMaintenanceJobStatus']
const WRITE = [
  's3tables:CreateNamespace',
  's3tables:UpdateNamespaceProperties',
  's3tables:DeleteNamespace',
  's3tables:CreateTable',
  's3tables:UpdateTable',
  's3tables:RenameTable',
  's3tables:DeleteTable',
]

const TABLE_READ = ['s3tables:GetTable', 's3tables:GetTableData', 's3tables:GetTableMaintenanceJobStatus']
const TABLE_WRITE = ['s3tables:UpdateTable', 's3tables:RenameTable', 's3tables:DeleteTable']
const VIEW_READ = ['s3tables:GetView']
const VIEW_WRITE = ['s3tables:UpdateView', 's3tables:RenameView', 's3tables:DeleteView']

export interface AccessResource {
  kind: 'table' | 'view'
  uuid: string
}

function policy(wh: string, actions: string[], ns?: Namespace, res?: AccessResource) {
  const resources = res ? [res.kind === 'table' ? resourceArn.table(wh, res.uuid) : resourceArn.view(wh, res.uuid)] : [arn.warehouse(wh), arn.tables(wh), arn.views(wh)]
  const statement: Record<string, unknown> = { Effect: 'Allow', Action: actions, Resource: resources }
  if (ns?.length && !res) {
    // Namespace-level scoping is expressed with condition keys; namespace
    // operations themselves are authorised on the warehouse ARN.
    statement.Condition = { StringEquals: { 's3tables:namespace': ns.join('.') } }
  }
  return JSON.stringify({ Version: '2012-10-17', Statement: [statement] }, null, 2)
}

/**
 * Helps administrators write exact AIStor policies for this resource. The UI
 * itself grants nothing: every request is authorised by AIStor for the
 * signed-in user.
 */
export function AccessPanel({ warehouse, namespace, resource }: { warehouse: string; namespace?: Namespace; resource?: AccessResource }) {
  const [mode, setMode] = useState<'read' | 'write'>('read')
  const read = resource ? (resource.kind === 'table' ? TABLE_READ : VIEW_READ) : READ
  const write = resource ? (resource.kind === 'table' ? TABLE_WRITE : VIEW_WRITE) : WRITE
  const text = policy(warehouse, mode === 'read' ? read : [...read, ...write], namespace, resource)
  const arns: [string, string][] = resource
    ? [
        [`This ${resource.kind}`, resource.kind === 'table' ? resourceArn.table(warehouse, resource.uuid) : resourceArn.view(warehouse, resource.uuid)],
        ['Warehouse, namespaces', arn.warehouse(warehouse)],
      ]
    : [
        ['Warehouse, namespaces', arn.warehouse(warehouse)],
        ['All tables', arn.tables(warehouse)],
        ['All views', arn.views(warehouse)],
      ]
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
      <Card>
        <CardHeader title="Resource ARNs" description="Policies are evaluated against these resources." />
        <dl className="flex flex-col gap-3 p-4 text-[13px]">
          {arns.map(([label, value]) => (
            <div key={label}>
              <dt className="text-[12px] text-muted">{label}</dt>
              <dd>
                <CopyText value={value} />
              </dd>
            </div>
          ))}
          <div className="flex gap-2 rounded-[var(--radius-control)] bg-info-subtle px-3 py-2 text-[12px] text-info">
            <Info className="mt-0.5 size-4 shrink-0" />
            <span>
              Table and view ARNs end in the resource's stable UUID, so renaming never changes who can access it. Namespace operations are authorised on the warehouse ARN; the cleanest isolation boundary between teams is one warehouse per team.
            </span>
          </div>
        </dl>
      </Card>
      <Card>
        <CardHeader
          title="Example policy"
          description={
            resource
              ? `Grants access to this ${resource.kind} only, by its UUID.`
              : namespace?.length
                ? 'Scoped to this namespace with the s3tables:namespace condition key.'
                : 'Grants access to this warehouse only.'
          }
          actions={
            <div className="flex items-center gap-1">
              <div className="grid grid-cols-2 gap-0.5 rounded-[var(--radius-control)] bg-surface p-0.5 text-[12px]" role="tablist">
                {(['read', 'write'] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    onClick={() => setMode(m)}
                    className={cn('h-6 rounded-[4px] px-2 text-muted', mode === m && 'bg-bg font-medium text-fg shadow-sm')}
                  >
                    {m === 'read' ? 'Read-only' : 'Read-write'}
                  </button>
                ))}
              </div>
              <CopyButton value={text} label="Copy policy" />
            </div>
          }
        />
        <pre className="max-h-[420px] overflow-auto p-4 font-mono text-[12px] leading-5 text-fg">{text}</pre>
      </Card>
    </div>
  )
}
