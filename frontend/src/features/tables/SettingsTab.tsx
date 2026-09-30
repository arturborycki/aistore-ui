import { getTableEncryption, getTableTags, putTableEncryption, tagTable, untagTable } from '@/lib/catalog'
import type { Namespace } from '@/lib/namespace'
import { qk } from '@/lib/queryKeys'
import { EncryptionCard, TagsCard } from '@/features/settings/SettingsEditors'

/** Server-side encryption and resource tags (AIStor extension endpoints). */
export function SettingsTab({ cluster, wh, ns, table }: { cluster: string; wh: string; ns: Namespace; table: string }) {
  const key = qk.table(cluster, wh, ns, table)
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <EncryptionCard
        scope="table"
        queryKey={[...key, 'encryption']}
        load={() => getTableEncryption(cluster, wh, ns, table)}
        save={(c) => putTableEncryption(cluster, wh, ns, table, c)}
      />
      <TagsCard
        queryKey={[...key, 'tags']}
        description="Resource tags for cost allocation and governance."
        load={() => getTableTags(cluster, wh, ns, table)}
        add={(t) => tagTable(cluster, wh, ns, table, t)}
        remove={(k) => untagTable(cluster, wh, ns, table, k)}
      />
    </div>
  )
}
