import { useParams } from 'react-router'
import { useMe } from '@/auth/AuthContext'
import { decodeNamespaceParam } from '@/lib/namespace'

/** The cluster selected in the URL (falls back to the first available one). */
export function useCluster(): string {
  const { cluster } = useParams()
  const me = useMe()
  return cluster ?? me.clusters.find((c) => c.available)?.id ?? me.clusters[0]?.id ?? ''
}

export function useRouteEntity() {
  const { cluster, wh, ns } = useParams()
  return { cluster, wh, ns: decodeNamespaceParam(ns) }
}
