import { cn } from '@/lib/cn'
import { typeFamily, typeLabel, type IcebergType } from '@/lib/iceberg'

const family = {
  numeric: 'text-[#1d4ed8] bg-[#1d4ed8]/10 dark:text-[#93c5fd] dark:bg-[#3b82f6]/15',
  string: 'text-[#115e59] bg-[#115e59]/10 dark:text-[#5eead4] dark:bg-[#14b8a6]/15',
  temporal: 'text-[#7c3aed] bg-[#7c3aed]/10 dark:text-[#c4b5fd] dark:bg-[#8b5cf6]/15',
  boolean: 'text-[#9a3412] bg-[#9a3412]/10 dark:text-[#fdba74] dark:bg-[#f97316]/15',
  binary: 'text-[#52525b] bg-[#52525b]/10 dark:text-[#d4d4d8] dark:bg-[#71717a]/20',
  nested: 'text-[#be185d] bg-[#be185d]/10 dark:text-[#f9a8d4] dark:bg-[#ec4899]/15',
  other: 'text-muted bg-surface',
}

/** Iceberg type, coloured by family (text always carries the full label). */
export function TypeChip({ type, className }: { type: IcebergType; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 max-w-full items-center truncate rounded px-1.5 font-mono text-[11.5px]', family[typeFamily(type)], className)} title={typeLabel(type)}>
      {typeLabel(type)}
    </span>
  )
}
