import { Bot } from 'lucide-react'
import { Field, Textarea } from '@/components/ui/input'
import { TagInput } from '@/components/ui/tag-input'
import { aiContext, aiObject, type AIContext } from '@/lib/ossie'

/**
 * Edits an Ossie ai_context: instructions, synonyms and example questions.
 * Other keys (vendor additions) are preserved untouched.
 */
export function AIContextEditor({ value, onChange, subject, examples = true }: { value: AIContext | undefined; onChange: (v: AIContext | undefined) => void; subject: string; examples?: boolean }) {
  const obj = aiObject(value)
  const set = (patch: Record<string, unknown>) => onChange(aiContext({ ...obj, ...patch }))
  return (
    <div className="flex flex-col gap-3 rounded-[var(--radius-card)] border border-border bg-bg-subtle p-3">
      <p className="flex items-center gap-1.5 text-[12px] text-muted">
        <Bot className="size-3.5" /> Given to AI agents and tools that read this model. Keep it factual; it is shown with the model's history.
      </p>
      <Field label="Instructions">
        {(p) => (
          <Textarea {...p} rows={3} value={obj.instructions ?? ''} onChange={(e) => set({ instructions: e.target.value })} placeholder={`How should an agent use ${subject}?`} maxLength={4000} />
        )}
      </Field>
      <div className="flex flex-col gap-1.5">
        <span className="text-[12px] font-medium">Synonyms</span>
        <TagInput label={`Synonyms for ${subject}`} value={obj.synonyms ?? []} onChange={(synonyms) => set({ synonyms })} placeholder="Other names people use, then Enter" />
      </div>
      {examples && (
        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium">Example questions</span>
          <TagInput label={`Example questions about ${subject}`} value={obj.examples ?? []} onChange={(ex) => set({ examples: ex })} placeholder="e.g. revenue by month, then Enter" />
        </div>
      )}
    </div>
  )
}
