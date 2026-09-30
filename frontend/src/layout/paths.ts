import { encodeNamespace, type Namespace } from '@/lib/namespace'

const e = encodeURIComponent

export const paths = {
  overview: (c: string) => `/c/${e(c)}`,
  warehouses: (c: string) => `/c/${e(c)}/warehouses`,
  warehouse: (c: string, wh: string, tab?: string) => `/c/${e(c)}/wh/${e(wh)}${tab ? `?tab=${tab}` : ''}`,
  namespace: (c: string, wh: string, ns: Namespace) => `/c/${e(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}`,
  table: (c: string, wh: string, ns: Namespace, t: string, tab?: string) =>
    `/c/${e(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}/t/${e(t)}${tab ? `?tab=${tab}` : ''}`,
  view: (c: string, wh: string, ns: Namespace, v: string, tab?: string) =>
    `/c/${e(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}/v/${e(v)}${tab ? `?tab=${tab}` : ''}`,
  createTable: (c: string, wh: string, ns: Namespace) => `/c/${e(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}/new-table`,
  activity: (c: string) => `/c/${e(c)}/activity`,
}
