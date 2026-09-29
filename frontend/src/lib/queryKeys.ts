import type { Namespace } from './namespace'

export const qk = {
  globalStats: (c: string) => ['cluster', c, 'global-stats'] as const,
  warehouses: (c: string) => ['cluster', c, 'warehouses'] as const,
  warehouse: (c: string, wh: string) => ['cluster', c, 'warehouse', wh] as const,
  namespaces: (c: string, wh: string, parent: Namespace) => ['cluster', c, 'warehouse', wh, 'namespaces', parent.join('\u001f')] as const,
  namespace: (c: string, wh: string, ns: Namespace) => ['cluster', c, 'warehouse', wh, 'namespace', ns.join('\u001f')] as const,
  tables: (c: string, wh: string, ns: Namespace) => ['cluster', c, 'warehouse', wh, 'namespace', ns.join('\u001f'), 'tables'] as const,
  views: (c: string, wh: string, ns: Namespace) => ['cluster', c, 'warehouse', wh, 'namespace', ns.join('\u001f'), 'views'] as const,
  table: (c: string, wh: string, ns: Namespace, t: string) => ['cluster', c, 'warehouse', wh, 'namespace', ns.join('\u001f'), 'table', t] as const,
  view: (c: string, wh: string, ns: Namespace, v: string) => ['cluster', c, 'warehouse', wh, 'namespace', ns.join('\u001f'), 'view', v] as const,
  activity: (scope: string) => ['activity', scope] as const,
}
