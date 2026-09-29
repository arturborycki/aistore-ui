import { Eye, Folder, FolderOpen, Table2, Warehouse } from 'lucide-react'
import { cn } from '@/lib/cn'

export type EntityKind = 'warehouse' | 'namespace' | 'table' | 'view'

export function EntityIcon({ kind, open, className }: { kind: EntityKind; open?: boolean; className?: string }) {
  const cls = cn('size-4 shrink-0', className)
  switch (kind) {
    case 'warehouse':
      return <Warehouse className={cn(cls, 'text-ent-warehouse')} aria-hidden />
    case 'namespace':
      return open ? <FolderOpen className={cn(cls, 'text-ent-namespace')} aria-hidden /> : <Folder className={cn(cls, 'text-ent-namespace')} aria-hidden />
    case 'table':
      return <Table2 className={cn(cls, 'text-ent-table')} aria-hidden />
    case 'view':
      return <Eye className={cn(cls, 'text-ent-view')} aria-hidden />
  }
}

/** A tinted square used in entity headers. */
export function EntityBadgeIcon({ kind }: { kind: EntityKind }) {
  const bg = {
    warehouse: 'bg-ent-warehouse/10',
    namespace: 'bg-ent-namespace/10',
    table: 'bg-ent-table/10',
    view: 'bg-ent-view/10',
  }[kind]
  return (
    <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-card)]', bg)}>
      <EntityIcon kind={kind} className="size-5" />
    </span>
  )
}
