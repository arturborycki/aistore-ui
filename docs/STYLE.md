# Visual style

Based on a review of data-catalog UIs (Databricks Catalog Explorer, Snowflake Horizon, Lakekeeper, Gravitino, AWS S3 Tables, OpenMetadata/DataHub) and dense developer tools (Vercel Geist, Linear, Supabase Studio). The goal is an interface that shows a lot of information but stays easy to use.

## Layout
- **Three-zone shell.** A resizable, collapsible explorer tree on the left (220–380 px) loads warehouses, then nested namespaces, then tables and views, each with its own icon. A breadcrumb header sits above the content, and entity pages are split into tabs. Only the IDs of expanded tree nodes are persisted.
- **Entity header.** Shows a tinted type icon, the name in mono, and badges (format version, encryption, maintenance). Actions go on the right; destructive actions sit in an overflow menu.
- **Stat-card row** under warehouse and namespace headers. The numbers come from AIStor's statistics-mode listings.
- **List pages.** Dense tables with server-side search, sortable columns and page counts (`X-Minio-Ui-Total-Count`).
- **Command palette** (⌘K / Ctrl-K) jumps to anything already loaded and runs common commands.

## Components
- **Status badges** use a dot or icon plus a label on a tinted background. Color is never the only signal.
- **Empty states explain why.** Examples: "no namespaces yet", "no access" (which names the missing `s3tables:` action and ARN), "not found".
- **Destructive confirmation.** The dialog states the consequence and requires typing the name. The action button is red and stays disabled until the name matches. Data-destroying options such as purge or bucket deletion are off by default.
- **Properties editor.** A mono key/value grid where edits are staged and committed atomically; the server reports what was set, removed and missing.
- **Planned** (phase 1): a schema tree-table with type chips, a snapshot timeline, and a virtualized preview grid.

## Visual language
- **Type.** Inter Variable for UI text (13 px base, 12 px secondary, 11 px uppercase micro-labels). JetBrains Mono Variable for identifiers, types, IDs and paths. Numbers use tabular figures. Both fonts are self-hosted (CSP `font-src 'self'`).
- **Density.** 36 px table rows, 28 px tree rows, 32 px controls, on a 4 px spacing scale.
- **Neutrals (zinc).**
  - Light: bg `#FFFFFF`, subtle `#FAFAFA`, surface `#F4F4F5`, border `#E4E4E7`, text `#18181B`, muted `#52525B`, subtle `#686871`.
  - Dark: bg `#09090B`, sidebar `#0F0F11`, surface `#18181B`, border `#27272A`, text `#FAFAFA`, muted `#A1A1AA`, subtle `#8B8B94`.
  - Every text token meets WCAG 2.1 AA (4.5:1) on every background token it is used on; the e2e suite enforces this with axe.
  - The sidebar is slightly dimmer than the content area.
- **Accent.** Blue `#2563EB` in light mode, `#3B82F6` in dark. MinIO crimson `#C72C48` is used only in the logo, so it never reads as danger.
- **Semantic colors.** Success `#16A34A`, warning `#D97706`, danger `#DC2626`, info `#0891B2`, each with a 10–15 % tint for badge backgrounds.
- **Entity hues.** Warehouse violet `#7C3AED`, namespace amber `#D97706`, table blue `#2563EB`, view teal `#0D9488`.
- **Icons.** Lucide, 16 px, outline. Mapping: warehouse `warehouse`, namespace `folder`/`folder-open`, table `table-2`, view `eye`, and `list-tree`, `rows-3`, `wrench`, `lock`, `tag`, `sliders-horizontal` for the table tabs.
- **Shape.** Radius is 6 px for controls, 8 px for cards and 12 px for modals. Surfaces use hairline borders; only popovers and modals get shadows.
- **Motion.** 120–160 ms ease-out, applied only to tree expansion, dialogs and tabs. `prefers-reduced-motion` is honored.

All tokens live in `frontend/src/index.css`, and components use only the semantic names.
