import * as S from '@radix-ui/react-switch'
import * as C from '@radix-ui/react-checkbox'
import { Check } from 'lucide-react'
import { cn } from '@/lib/cn'

export function Switch({ checked, onCheckedChange, id, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string; disabled?: boolean }) {
  return (
    <S.Root
      id={id}
      checked={checked}
      disabled={disabled}
      onCheckedChange={onCheckedChange}
      className="relative h-5 w-9 shrink-0 rounded-full bg-border-strong transition-colors data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <S.Thumb className="block size-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  )
}

export function Checkbox({
  checked,
  onCheckedChange,
  id,
  className,
  label,
  disabled,
}: {
  checked: boolean
  onCheckedChange: (v: boolean) => void
  id?: string
  className?: string
  label?: string
  disabled?: boolean
}) {
  return (
    <C.Root
      id={id}
      aria-label={label}
      disabled={disabled}
      checked={checked}
      onCheckedChange={(v) => onCheckedChange(v === true)}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-border-strong bg-bg data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-40',
        className,
      )}
    >
      <C.Indicator>
        <Check className="size-3 text-white" strokeWidth={3} />
      </C.Indicator>
    </C.Root>
  )
}
