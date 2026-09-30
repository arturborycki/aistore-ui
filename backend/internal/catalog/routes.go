// Package catalog defines the typed allow-list of AIStor Tables operations the
// UI may perform, and proxies each one to AIStor signed with the calling
// user's own credentials. There is deliberately no generic pass-through: an
// operation that is not in Routes cannot be reached through the server.
package catalog

import (
	"net/http"
	"net/url"
	"strings"
)

// Params are the validated path parameters of a request.
type Params struct {
	Warehouse string
	Namespace []string
	Name      string // table or view name
	Type      string // maintenance type
}

// NamespaceString renders the namespace for humans and audit records.
func (p *Params) NamespaceString() string { return strings.Join(p.Namespace, ".") }

// Route describes one allowed operation.
type Route struct {
	// Operation is the AIStor operation name (e.g. "ListTables").
	Operation string
	// Action is the s3tables policy action the operation requires. Actions
	// marked Documented=false are inferred from the operation name.
	Action     string
	Documented bool
	Method     string
	// Pattern is relative to /api/c/{cluster}.
	Pattern  string
	Upstream func(p *Params) []string
	Query    map[string]QueryRule
	// FixedQuery is added to the upstream query (e.g. the warehouse for /config).
	FixedQuery func(p *Params) url.Values
	Body       BodyValidator
	// StepUp reports whether this request needs a recent re-authentication.
	StepUp func(q url.Values) bool
	// Redact strips storage credentials from Iceberg LoadTable/LoadView-shaped responses.
	Redact bool
	// NoStore marks responses that contain table data.
	DataResponse bool
}

// Mutating reports whether the route changes state (and is therefore audited and CSRF-protected).
func (r *Route) Mutating() bool { return r.Method != http.MethodGet && r.Method != http.MethodHead }

// Resource returns the ARN that the route's action is evaluated against.
func (r *Route) Resource(p *Params) string {
	if p.Warehouse == "" {
		return "arn:aws:s3tables:::bucket/*"
	}
	base := "arn:aws:s3tables:::bucket/" + p.Warehouse
	switch {
	case strings.Contains(r.Pattern, "/t/{table}") || r.Operation == "CreateTable" || r.Operation == "RegisterTable" || r.Operation == "RenameTable" || r.Operation == "CommitMultiTableTransaction":
		return base + "/table/*"
	case strings.Contains(r.Pattern, "/v/{view}") || r.Operation == "CreateView" || r.Operation == "RegisterView" || r.Operation == "RenameView":
		return base + "/view/*"
	}
	return base
}

func always(url.Values) bool { return true }

func wh(p *Params) string { return p.Warehouse }

// ns renders the namespace as a single upstream path segment (levels joined by 0x1F).
func ns(p *Params) string { return strings.Join(p.Namespace, "\x1f") }

func seg(parts ...string) []string { return parts }

// MaintenanceTypes are the automated maintenance jobs AIStor runs.
var MaintenanceTypes = []string{"icebergSnapshotManagement", "icebergCompaction", "icebergUnreferencedFileRemoval"}

// Routes returns the complete operation table. previewMax caps PreviewTable rows.
func Routes(previewMax int) []*Route {
	tableQ := map[string]QueryRule{"snapshots": {Check: qEnum("all", "refs")}}
	return []*Route{
		// ---- cluster level
		{Operation: "GetGlobalStats", Action: "s3tables:GetGlobalStats", Method: "GET", Pattern: "/stats",
			Upstream: func(*Params) []string { return seg("stats") }},
		{Operation: "ListWarehouses", Action: "s3tables:ListWarehouses", Documented: true, Method: "GET", Pattern: "/warehouses",
			Upstream: func(*Params) []string { return seg("warehouses") }, Query: listQuery("namespaces", "tables", "records", "size")},
		{Operation: "CreateWarehouse", Action: "s3tables:CreateWarehouse", Documented: true, Method: "POST", Pattern: "/warehouses",
			Upstream: func(*Params) []string { return seg("warehouses") }, Body: vCreateWarehouse},

		// ---- warehouse
		{Operation: "GetConfig", Action: "", Documented: true, Method: "GET", Pattern: "/wh/{wh}/config",
			Upstream:   func(*Params) []string { return seg("config") },
			FixedQuery: func(p *Params) url.Values { return url.Values{"warehouse": {p.Warehouse}} }, Redact: true},
		{Operation: "GetWarehouse", Action: "s3tables:GetWarehouse", Documented: true, Method: "GET", Pattern: "/wh/{wh}",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p)) }},
		{Operation: "DeleteWarehouse", Action: "s3tables:DeleteWarehouse", Documented: true, Method: "DELETE", Pattern: "/wh/{wh}",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p)) },
			Query:    map[string]QueryRule{"preserveBucket": {Upstream: "preserve-bucket", Required: true, Check: qBool}},
			StepUp:   always},
		{Operation: "GetWarehouseEncryption", Action: "s3tables:GetWarehouseEncryption", Method: "GET", Pattern: "/wh/{wh}/encryption",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "encryption") }},
		{Operation: "PutWarehouseEncryption", Action: "s3tables:PutWarehouseEncryption", Method: "PUT", Pattern: "/wh/{wh}/encryption",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "encryption") }, Body: anyObject},
		{Operation: "DeleteWarehouseEncryption", Action: "s3tables:DeleteWarehouseEncryption", Method: "DELETE", Pattern: "/wh/{wh}/encryption",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "encryption") }},
		{Operation: "ListWarehouseTags", Action: "s3tables:ListWarehouseTags", Method: "GET", Pattern: "/wh/{wh}/tags",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "tags") }},
		{Operation: "TagWarehouse", Action: "s3tables:TagWarehouse", Method: "POST", Pattern: "/wh/{wh}/tags",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "tags") }, Body: anyObject},
		{Operation: "UntagWarehouse", Action: "s3tables:UntagWarehouse", Method: "DELETE", Pattern: "/wh/{wh}/tags",
			Upstream: func(p *Params) []string { return seg("warehouses", wh(p), "tags") },
			Query:    map[string]QueryRule{"tagKeys": {Required: true, Multi: true, Check: qText(128)}}},
		{Operation: "GetWarehouseMaintenanceConfiguration", Action: "s3tables:GetWarehouseMaintenanceConfiguration", Method: "GET", Pattern: "/wh/{wh}/maintenance",
			Upstream: func(p *Params) []string { return seg(wh(p), "maintenance") }},
		{Operation: "PutWarehouseMaintenanceConfiguration", Action: "s3tables:PutWarehouseMaintenanceConfiguration", Method: "PUT", Pattern: "/wh/{wh}/maintenance/{type}",
			Upstream: func(p *Params) []string { return seg(wh(p), "maintenance", p.Type) }, Body: anyObject},

		// ---- namespaces
		{Operation: "ListNamespaces", Action: "s3tables:ListNamespaces", Documented: true, Method: "GET", Pattern: "/wh/{wh}/namespaces",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces") },
			Query:    withRule(listQuery("tables", "records", "size"), "parent", QueryRule{Check: qNamespace})},
		{Operation: "CreateNamespace", Action: "s3tables:CreateNamespace", Documented: true, Method: "POST", Pattern: "/wh/{wh}/namespaces",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces") }, Body: vCreateNamespace},
		{Operation: "GetNamespace", Action: "s3tables:GetNamespace", Documented: true, Method: "GET", Pattern: "/wh/{wh}/ns/{ns}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p)) }},
		{Operation: "DeleteNamespace", Action: "s3tables:DeleteNamespace", Documented: true, Method: "DELETE", Pattern: "/wh/{wh}/ns/{ns}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p)) }},
		{Operation: "UpdateNamespaceProperties", Action: "s3tables:UpdateNamespaceProperties", Documented: true, Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/properties",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "properties") }, Body: vNamespaceProperties},

		// ---- tables
		{Operation: "ListTables", Action: "s3tables:ListTables", Documented: true, Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/tables",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables") }, Query: listQuery("records", "size")},
		{Operation: "CreateTable", Action: "s3tables:CreateTable", Documented: true, Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/tables",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables") }, Body: vCreateTable, Redact: true},
		{Operation: "RegisterTable", Action: "s3tables:RegisterTable", Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/register",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "register") }, Body: vRegister("table"), Redact: true},
		{Operation: "LoadTable", Action: "s3tables:GetTable", Documented: true, Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name) }, Query: tableQ, Redact: true},
		{Operation: "CommitTable", Action: "s3tables:UpdateTable", Documented: true, Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/t/{table}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name) }, Body: vCommitTable, Redact: true},
		{Operation: "DeleteTable", Action: "s3tables:DeleteTable", Documented: true, Method: "DELETE", Pattern: "/wh/{wh}/ns/{ns}/t/{table}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name) },
			// AIStor defaults purgeRequested to TRUE. The BFF therefore requires the
			// caller to choose explicitly and always forwards the parameter.
			Query:  map[string]QueryRule{"purge": {Upstream: "purgeRequested", Required: true, Check: qBool}},
			StepUp: func(q url.Values) bool { return q.Get("purge") == "true" }},
		{Operation: "RenameTable", Action: "s3tables:RenameTable", Documented: true, Method: "POST", Pattern: "/wh/{wh}/tables/rename",
			Upstream: func(p *Params) []string { return seg(wh(p), "tables", "rename") }, Body: vRename("table")},
		{Operation: "CommitMultiTableTransaction", Action: "s3tables:UpdateTable", Method: "POST", Pattern: "/wh/{wh}/transactions/commit",
			Upstream: func(p *Params) []string { return seg(wh(p), "transactions", "commit") }, Body: vTransaction},
		{Operation: "PreviewTable", Action: "s3tables:GetTableData", Documented: true, Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/preview",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "preview") },
			Query:    map[string]QueryRule{"limit": {Check: qIntRange(1, previewMax)}}, DataResponse: true},
		{Operation: "ListTableSnapshots", Action: "s3tables:GetTable", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/snapshots",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "snapshots") }},
		{Operation: "GetTableMaintenanceConfiguration", Action: "s3tables:GetTableMaintenanceConfiguration", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/maintenance",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "maintenance") }},
		{Operation: "PutTableMaintenanceConfiguration", Action: "s3tables:PutTableMaintenanceConfiguration", Method: "PUT", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/maintenance/{type}",
			Upstream: func(p *Params) []string {
				return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "maintenance", p.Type)
			}, Body: anyObject},
		{Operation: "DeleteTableMaintenanceConfiguration", Action: "s3tables:DeleteTableMaintenanceConfiguration", Method: "DELETE", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/maintenance/{type}",
			Upstream: func(p *Params) []string {
				return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "maintenance", p.Type)
			}},
		{Operation: "GetTableMaintenanceJobStatus", Action: "s3tables:GetTableMaintenanceJobStatus", Documented: true, Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/maintenance-job-status",
			Upstream: func(p *Params) []string {
				return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "maintenance-job-status")
			}},
		{Operation: "GetTableEncryption", Action: "s3tables:GetTableEncryption", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/encryption",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "encryption") }},
		{Operation: "PutTableEncryption", Action: "s3tables:PutTableEncryption", Method: "PUT", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/encryption",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "encryption") }, Body: anyObject},
		{Operation: "ListTableTags", Action: "s3tables:ListTableTags", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/tags",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "tags") }},
		{Operation: "TagTable", Action: "s3tables:TagTable", Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/tags",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "tags") }, Body: anyObject},
		{Operation: "UntagTable", Action: "s3tables:UntagTable", Method: "DELETE", Pattern: "/wh/{wh}/ns/{ns}/t/{table}/tags",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "tables", p.Name, "tags") },
			Query:    map[string]QueryRule{"tagKeys": {Required: true, Multi: true, Check: qText(128)}}},

		// ---- views
		{Operation: "ListViews", Action: "s3tables:ListViews", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/views",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "views") },
			Query:    map[string]QueryRule{"pageToken": {Check: qText(maxTokenLen)}, "pageSize": {Check: qIntRange(1, 1000)}}},
		{Operation: "CreateView", Action: "s3tables:CreateView", Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/views",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "views") }, Body: vCreateView, Redact: true},
		{Operation: "RegisterView", Action: "s3tables:RegisterView", Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/register-view",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "register-view") }, Body: vRegister("view"), Redact: true},
		{Operation: "LoadView", Action: "s3tables:GetView", Method: "GET", Pattern: "/wh/{wh}/ns/{ns}/v/{view}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "views", p.Name) }, Redact: true},
		{Operation: "CommitView", Action: "s3tables:UpdateView", Method: "POST", Pattern: "/wh/{wh}/ns/{ns}/v/{view}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "views", p.Name) }, Body: vCommitView, Redact: true},
		{Operation: "DropView", Action: "s3tables:DeleteView", Method: "DELETE", Pattern: "/wh/{wh}/ns/{ns}/v/{view}",
			Upstream: func(p *Params) []string { return seg(wh(p), "namespaces", ns(p), "views", p.Name) }},
		{Operation: "RenameView", Action: "s3tables:RenameView", Method: "POST", Pattern: "/wh/{wh}/views/rename",
			Upstream: func(p *Params) []string { return seg(wh(p), "views", "rename") }, Body: vRename("view")},
	}
}

func withRule(m map[string]QueryRule, name string, r QueryRule) map[string]QueryRule {
	m[name] = r
	return m
}
