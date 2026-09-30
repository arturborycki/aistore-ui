import { cn } from '@/lib/cn'

export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-6', className)} aria-hidden>
      <rect width="32" height="32" rx="7" className="fill-fg" />
      <path d="M8 11.5 16 7l8 4.5v9L16 25l-8-4.5z" fill="none" stroke="var(--brand)" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M8 11.5 16 16l8-4.5M16 16v9" fill="none" className="stroke-bg" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}
