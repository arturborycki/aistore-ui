import { encodeNamespace, type Namespace } from '@/lib/namespace'

const e = encodeURIComponent

export const paths = {
  overview: (c: string) => `/c/${e(c)}`,
  warehouses: (c: string) => `/c/${e(c)}/warehouses`,
  warehouse: (c: string, wh: string, tab?: string) => `/c/${e(c)}/wh/${e(wh)}${tab ? `?tab=${tab}` : ''}`,
  namespace: (c: string, wh: string, ns: Namespace) => `/c/${e(c)}/wh/${e(wh)}/ns/${encodeNamespace(ns)}`,
  activity: (c: string) => `/c/${e(c)}/activity`,
}
