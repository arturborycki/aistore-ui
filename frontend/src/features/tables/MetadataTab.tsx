import { Download, FileJson } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CopyText } from '@/components/ui/copy-button'
import { JsonView } from '@/components/ui/json-view'
import { Card, CardHeader } from '@/components/ui/layout'
import { formatDateTime } from '@/lib/format'
import { stringifyJSON } from '@/lib/json'

/** Raw (credential-redacted) metadata document plus the metadata-file history. */
export function MetadataTab({ name, metadata, location, log }: { name: string; metadata: unknown; location?: string | null; log?: { 'metadata-file': string; 'timestamp-ms': number }[] }) {
  const download = () => {
    const pretty = JSON.stringify(JSON.parse(stringifyJSON(metadata)), null, 2)
    const url = URL.createObjectURL(new Blob([pretty], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${name}.metadata.json`
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><FileJson className="size-4 text-muted" />Metadata</span>}
          description="As returned by the catalog, with any storage credentials removed by the server."
          actions={
            <Button size="sm" variant="outline" onClick={download}>
              <Download /> Download
            </Button>
          }
        />
        <div className="max-h-[70vh] overflow-auto p-3">
          <JsonView value={metadata} defaultDepth={1} />
        </div>
      </Card>
      <div className="flex flex-col gap-4">
        {location && (
          <Card>
            <CardHeader title="Current metadata file" />
            <div className="p-4">
              <CopyText value={location} className="max-w-full" />
            </div>
          </Card>
        )}
        {log && log.length > 0 && (
          <Card>
            <CardHeader title="Metadata history" description={`${log.length} previous metadata files`} />
            <ol className="max-h-[50vh] overflow-auto">
              {[...log].reverse().map((m) => (
                <li key={m['metadata-file']} className="border-b border-border px-4 py-2 last:border-0">
                  <div className="text-[12px] text-muted">{formatDateTime(m['timestamp-ms'])}</div>
                  <CopyText value={m['metadata-file']} className="max-w-full" />
                </li>
              ))}
            </ol>
          </Card>
        )}
      </div>
    </div>
  )
}
