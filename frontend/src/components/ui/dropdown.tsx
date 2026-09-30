import * as M from '@radix-ui/react-dropdown-menu'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export const Menu = M.Root
export const MenuTrigger = M.Trigger

export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <M.Portal>
      <M.Content
        align={align}
        sideOffset={4}
        className={cn(
          'z-50 min-w-44 rounded-[var(--radius-card)] border border-border bg-bg p-1 shadow-pop data-[state=open]:animate-pop-in',
          className,
        )}
      >
        {children}
      </M.Content>
    </M.Portal>
  )
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
  icon,
}: {
  children: ReactNode
  onSelect?: () => void
  danger?: boolean
  disabled?: boolean
  icon?: ReactNode
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex h-8 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[13px] outline-none',
        'data-[highlighted]:bg-surface data-[disabled]:opacity-50 [&_svg]:size-4 [&_svg]:text-muted',
        danger && 'text-danger data-[highlighted]:bg-danger-subtle [&_svg]:text-danger',
      )}
    >
      {icon}
      {children}
    </M.Item>
  )
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-subtle">{children}</M.Label>
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-border" />
}

export const MenuRadioGroup = M.RadioGroup

export function MenuRadioItem({ value, children, icon }: { value: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <M.RadioItem
      value={value}
      className="flex h-8 cursor-default select-none items-center gap-2 rounded-[5px] px-2 text-[13px] outline-none data-[highlighted]:bg-surface data-[state=checked]:text-accent-text [&_svg]:size-4"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <M.ItemIndicator className="size-1.5 rounded-full bg-accent" />
    </M.RadioItem>
  )
}
