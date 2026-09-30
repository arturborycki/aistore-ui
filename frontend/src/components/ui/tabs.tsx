import * as T from '@radix-ui/react-tabs'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const Tabs = T.Root

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <T.List className={cn('flex items-center gap-1 border-b border-border', className)}>{children}</T.List>
}

export function TabsTrigger({ value, children, icon, count }: { value: string; children: ReactNode; icon?: ReactNode; count?: number }) {
  return (
    <T.Trigger
      value={value}
      className={cn(
        'relative -mb-px flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-2.5 text-[13px] text-muted transition-colors',
        'hover:text-fg data-[state=active]:border-accent data-[state=active]:font-medium data-[state=active]:text-fg [&_svg]:size-4',
      )}
    >
      {icon}
      {children}
      {count != null && <span className="rounded-full bg-surface px-1.5 text-[11px] tabular text-muted">{count}</span>}
    </T.Trigger>
  )
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <T.Content value={value} className={cn('pt-4 focus:outline-none data-[state=active]:animate-slide-in', className)}>
      {children}
    </T.Content>
  )
}
