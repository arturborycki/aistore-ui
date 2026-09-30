package aistortest

import (
	"encoding/json"
	"fmt"
	"hash/fnv"
	"math/rand"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// tableState holds Iceberg table metadata as the catalog would return it.
type tableState struct {
	name     string
	uuid     string
	records  int64
	size     int64
	metadata map[string]any
	metaLoc  string
	schemaIx int // index into templates
	maint    map[string]map[string]any
	maintCfg map[string]any
	tags     map[string]string
	sse      string
	kmsKey   string
	version  int
}

type viewState struct {
	name     string
	metadata map[string]any
	metaLoc  string
}

var tableNamePool = []string{"orders", "customers", "line_items", "payments", "refunds", "events", "sessions", "devices",
	"invoices", "ledger_entries", "accounts", "products", "inventory", "shipments", "clicks", "impressions",
	"campaigns", "features", "embeddings", "labels", "predictions", "runs", "metrics", "logs"}

func seeded(parts ...string) *rand.Rand {
	h := fnv.New64a()
	for _, p := range parts {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return rand.New(rand.NewSource(int64(h.Sum64())))
}

// ---------------------------------------------------------------- schema templates

type field = map[string]any

func prim(id int, name, typ string, req bool, doc string) field {
	f := field{"id": id, "name": name, "type": typ, "required": req}
	if doc != "" {
		f["doc"] = doc
	}
	return f
}

func structT(fields ...field) map[string]any {
	return map[string]any{"type": "struct", "fields": fields}
}

// schemaTemplate returns the schema history (oldest first) for template ix.
func schemaTemplate(ix int) [][]field {
	switch ix % 3 {
	case 0: // commerce
		v0 := []field{
			prim(1, "order_id", "long", true, "Unique order identifier"),
			prim(2, "customer_id", "long", true, ""),
			prim(3, "order_ts", "timestamptz", true, "When the order was placed"),
			prim(4, "status", "string", false, ""),
			prim(5, "amount", "decimal(12, 2)", true, "Order total in account currency"),
			{"id": 6, "name": "shipping", "required": false, "type": structT(
				prim(7, "street", "string", false, ""),
				prim(8, "city", "string", false, ""),
				prim(9, "country", "string", false, "ISO 3166-1 alpha-2"),
				field{"id": 10, "name": "geo", "required": false, "type": structT(prim(11, "lat", "double", false, ""), prim(12, "lon", "double", false, ""))},
			)},
			{"id": 13, "name": "items", "required": false, "type": map[string]any{"type": "list", "element-id": 14, "element-required": true,
				"element": structT(prim(15, "sku", "string", true, ""), prim(16, "qty", "int", true, ""), prim(17, "price", "decimal(10, 2)", true, ""))}},
		}
		v1 := append(clone(v0), field{"id": 18, "name": "tags", "required": false, "type": map[string]any{"type": "map", "key-id": 19, "key": "string", "value-id": 20, "value": "string", "value-required": false}})
		v2 := clone(v1)
		v2[3] = prim(4, "order_status", "string", false, "Renamed from status")
		v2 = append(v2, prim(21, "channel", "string", false, "web, store or app"))
		return [][]field{v0, v1, v2}
	case 1: // telemetry
		v0 := []field{
			prim(1, "event_id", "uuid", true, ""),
			prim(2, "device_id", "string", true, ""),
			prim(3, "ts", "timestamp", true, "Event time (UTC)"),
			prim(4, "kind", "string", true, ""),
			prim(5, "payload", "binary", false, "Raw protobuf payload"),
		}
		v1 := append(clone(v0), field{"id": 6, "name": "metrics", "required": false, "type": map[string]any{"type": "map", "key-id": 7, "key": "string", "value-id": 8, "value": "double", "value-required": false}})
		v1[1] = prim(2, "device_id", "string", true, "Hardware serial")
		return [][]field{v0, v1}
	default: // features
		return [][]field{{
			prim(1, "entity_id", "string", true, ""),
			prim(2, "feature_ts", "timestamp", true, ""),
			{"id": 3, "name": "vector", "required": true, "type": map[string]any{"type": "list", "element-id": 4, "element": "float", "element-required": true}},
			prim(5, "model_version", "int", false, ""),
			prim(6, "score", "double", false, ""),
			prim(7, "label", "boolean", false, ""),
			prim(8, "fingerprint", "fixed[16]", false, ""),
		}}
	}
}

func clone(f []field) []field { return append([]field(nil), f...) }

func maxFieldID(v any) int {
	m := 0
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case []field:
			for _, f := range t {
				walk(f)
			}
		case field:
			for k, v := range t {
				if strings.HasSuffix(k, "id") {
					if n, ok := v.(int); ok && n > m {
						m = n
					}
				}
				walk(v)
			}
		case []any:
			for _, e := range t {
				walk(e)
			}
		}
	}
	walk(v)
	return m
}

// ---------------------------------------------------------------- metadata

func newTable(wh string, ns []string, name string, records, size int64, ix int) *tableState {
	r := seeded(wh, strings.Join(ns, "."), name)
	uuid := fakeUUID(wh + "/" + strings.Join(ns, ".") + "/" + name)
	loc := fmt.Sprintf("s3://%s/%s/%s", wh, strings.Join(ns, "/"), name)
	history := schemaTemplate(ix)
	schemas := make([]any, 0, len(history))
	for i, fs := range history {
		schemas = append(schemas, map[string]any{"type": "struct", "schema-id": i, "fields": fs, "identifier-field-ids": []int{1}})
	}
	tsField := 3
	if ix%3 == 2 {
		tsField = 2
	}
	specs := []any{map[string]any{"spec-id": 0, "fields": []any{
		map[string]any{"name": "ts_day", "transform": "day", "source-id": tsField, "field-id": 1000},
	}}}
	lastPartID := 1000
	if ix%3 == 0 {
		specs = append(specs, map[string]any{"spec-id": 1, "fields": []any{
			map[string]any{"name": "ts_day", "transform": "day", "source-id": tsField, "field-id": 1000},
			map[string]any{"name": "customer_bucket", "transform": "bucket[16]", "source-id": 2, "field-id": 1001},
		}})
		lastPartID = 1001
	}
	sortOrders := []any{
		map[string]any{"order-id": 0, "fields": []any{}},
		map[string]any{"order-id": 1, "fields": []any{
			map[string]any{"transform": "identity", "source-id": tsField, "direction": "asc", "null-order": "nulls-first"},
			map[string]any{"transform": "identity", "source-id": 1, "direction": "desc", "null-order": "nulls-last"},
		}},
	}

	// Snapshot history: 64-bit IDs above 2^53 to exercise precision handling.
	nSnaps := 6 + r.Intn(7)
	now := time.Now().Add(-time.Duration(r.Intn(48)) * time.Hour)
	var snaps []any
	var snapLog, metaLog []any
	var total, totalSize, totalFiles int64
	var parent *int64
	ops := []string{"append", "append", "append", "overwrite", "append", "delete", "replace"}
	for i := 0; i < nSnaps; i++ {
		id := int64(1)<<60 + r.Int63n(1<<59)
		ts := now.Add(-time.Duration(nSnaps-i) * time.Duration(6+r.Intn(30)) * time.Hour).UnixMilli()
		op := ops[r.Intn(len(ops))]
		if i == 0 {
			op = "append"
		}
		share := records / int64(nSnaps)
		added, deleted := share+r.Int63n(max(1, share/5)), int64(0)
		switch op {
		case "delete":
			added, deleted = 0, min(total, share/3+1)
		case "overwrite":
			deleted = min(total, share/2)
		case "replace":
			added, deleted = 0, 0
		}
		total += added - deleted
		files := int64(4 + r.Intn(40))
		if op == "replace" {
			totalFiles = max(1, totalFiles/3)
		} else {
			totalFiles += files
		}
		totalSize = size * int64(i+1) / int64(nSnaps)
		summary := map[string]any{
			"operation": op, "added-records": strconv.FormatInt(added, 10), "deleted-records": strconv.FormatInt(deleted, 10),
			"added-data-files": strconv.FormatInt(files, 10), "total-records": strconv.FormatInt(total, 10),
			"total-files-size": strconv.FormatInt(totalSize, 10), "total-data-files": strconv.FormatInt(totalFiles, 10),
			"total-delete-files": "0", "spark.app.id": fmt.Sprintf("app-%d", 20260000+r.Intn(9999)),
		}
		if op == "replace" {
			summary["added-data-files"] = "0"
			summary["rewritten-data-files"] = strconv.FormatInt(files*3, 10)
		}
		s := map[string]any{"snapshot-id": id, "sequence-number": i + 1, "timestamp-ms": ts, "summary": summary,
			"manifest-list": fmt.Sprintf("%s/metadata/snap-%d-1-%s.avro", loc, id, uuid[:8]), "schema-id": min(len(history)-1, i*len(history)/nSnaps)}
		if parent != nil {
			s["parent-snapshot-id"] = *parent
		}
		snaps = append(snaps, s)
		snapLog = append(snapLog, map[string]any{"snapshot-id": id, "timestamp-ms": ts})
		metaLog = append(metaLog, map[string]any{"metadata-file": fmt.Sprintf("s3://%s/.aistor-tables/%s/%s/metadata/v%d.metadata.json", wh, strings.Join(ns, "/"), name, i+1), "timestamp-ms": ts})
		p := id
		parent = &p
	}
	current := *parent
	refs := map[string]any{"main": map[string]any{"snapshot-id": current, "type": "branch"}}
	if len(snaps) > 3 {
		refs["eom-2026-08"] = map[string]any{"snapshot-id": snaps[len(snaps)-3].(map[string]any)["snapshot-id"], "type": "tag", "max-ref-age-ms": 7776000000}
		refs["audit"] = map[string]any{"snapshot-id": snaps[len(snaps)-2].(map[string]any)["snapshot-id"], "type": "branch", "min-snapshots-to-keep": 3}
	}
	metaLoc := fmt.Sprintf("s3://%s/.aistor-tables/%s/%s/metadata/v%d.metadata.json", wh, strings.Join(ns, "/"), name, nSnaps+1)
	md := map[string]any{
		"format-version": 2 + ix%2, "table-uuid": uuid, "location": loc, "last-sequence-number": nSnaps,
		"last-updated-ms": snaps[len(snaps)-1].(map[string]any)["timestamp-ms"], "last-column-id": maxFieldID(history[len(history)-1]),
		"current-schema-id": len(history) - 1, "schemas": schemas,
		"default-spec-id": len(specs) - 1, "partition-specs": specs, "last-partition-id": lastPartID,
		"default-sort-order-id": 1, "sort-orders": sortOrders,
		"properties": map[string]any{"owner": ns[0] + "-team", "write.format.default": "parquet", "write.parquet.compression-codec": "zstd",
			"history.expire.max-snapshot-age-ms": "432000000", "commit.retry.num-retries": "4"},
		"current-snapshot-id": current, "refs": refs, "snapshots": snaps, "statistics": []any{}, "partition-statistics": []any{},
		"snapshot-log": snapLog, "metadata-log": metaLog,
	}
	statuses := []string{"Successful", "Successful", "Successful", "Failed", "Not_Yet_Run", "Disabled"}
	maint := map[string]map[string]any{}
	for i, t := range []string{"icebergSnapshotManagement", "icebergCompaction", "icebergUnreferencedFileRemoval"} {
		st := statuses[r.Intn(len(statuses))]
		if i == 0 && r.Intn(3) > 0 {
			st = "Successful"
		}
		e := map[string]any{"status": st}
		if st == "Successful" || st == "Failed" {
			e["lastRunTimestamp"] = time.Now().Add(-time.Duration(1+r.Intn(30)) * time.Hour).UTC().Format(time.RFC3339)
		}
		if st == "Failed" {
			e["failureMessage"] = "compaction aborted: concurrent commit conflict"
		}
		maint[t] = e
	}
	return &tableState{name: name, uuid: uuid, records: total, size: size, metadata: normalize(md).(map[string]any), metaLoc: metaLoc, schemaIx: ix, maint: maint,
		maintCfg: defaultTableMaintenance(), version: nSnaps + 1,
		tags: map[string]string{"cost-center": "cc-" + strconv.Itoa(1000+r.Intn(8999)), "pii": strconv.FormatBool(ix%3 == 0)}, sse: "AES256"}
}

func newView(wh string, ns []string, name string, source string) *viewState {
	uuid := fakeUUID("view:" + wh + "/" + strings.Join(ns, ".") + "/" + name)
	now := time.Now()
	sql1 := fmt.Sprintf("SELECT customer_id,\n       sum(amount) AS revenue\nFROM %s\nGROUP BY customer_id", source)
	sql2 := fmt.Sprintf("SELECT customer_id,\n       date_trunc('month', order_ts) AS month,\n       sum(amount) AS revenue,\n       count(*) AS orders\nFROM %s\nWHERE order_status <> 'cancelled'\nGROUP BY 1, 2", source)
	schema := func(id int, extra bool) map[string]any {
		fs := []field{prim(1, "customer_id", "long", false, ""), prim(2, "revenue", "decimal(22, 2)", false, "")}
		if extra {
			fs = []field{prim(1, "customer_id", "long", false, ""), prim(2, "month", "timestamptz", false, ""), prim(3, "revenue", "decimal(22, 2)", false, ""), prim(4, "orders", "long", false, "")}
		}
		return map[string]any{"type": "struct", "schema-id": id, "fields": fs}
	}
	nsArr := append([]string(nil), ns...)
	md := map[string]any{
		"view-uuid": uuid, "format-version": 1, "location": fmt.Sprintf("s3://%s/%s/%s", wh, strings.Join(ns, "/"), name),
		"current-version-id": 2, "schemas": []any{schema(0, false), schema(1, true)},
		"versions": []any{
			map[string]any{"version-id": 1, "timestamp-ms": now.Add(-30 * 24 * time.Hour).UnixMilli(), "schema-id": 0, "default-namespace": nsArr,
				"summary":         map[string]any{"engine-name": "spark", "engine-version": "3.5.4"},
				"representations": []any{map[string]any{"type": "sql", "sql": sql1, "dialect": "spark"}}},
			map[string]any{"version-id": 2, "timestamp-ms": now.Add(-3 * 24 * time.Hour).UnixMilli(), "schema-id": 1, "default-namespace": nsArr,
				"summary": map[string]any{"engine-name": "trino", "engine-version": "476"},
				"representations": []any{
					map[string]any{"type": "sql", "sql": sql2, "dialect": "trino"},
					map[string]any{"type": "sql", "sql": strings.ReplaceAll(sql2, "date_trunc('month', order_ts)", "trunc(order_ts, 'MM')"), "dialect": "spark"},
				}},
		},
		"version-log": []any{map[string]any{"version-id": 1, "timestamp-ms": now.Add(-30 * 24 * time.Hour).UnixMilli()}, map[string]any{"version-id": 2, "timestamp-ms": now.Add(-3 * 24 * time.Hour).UnixMilli()}},
		"properties":  map[string]any{"comment": "Monthly revenue per customer", "owner": ns[0] + "-team"},
	}
	return &viewState{name: name, metadata: normalize(md).(map[string]any), metaLoc: fmt.Sprintf("s3://%s/.aistor-tables/%s/%s/metadata/00002.metadata.json", wh, strings.Join(ns, "/"), name)}
}

// populate creates count tables (and one view per namespace with tables).
func (ns *nsState) populate(wh string, count int, records, size int64) {
	ns.tbl = map[string]*tableState{}
	ns.views = map[string]*viewState{}
	r := seeded(wh, strings.Join(ns.levels, "."))
	start := r.Intn(len(tableNamePool))
	for i := 0; i < count; i++ {
		name := tableNamePool[(start+i)%len(tableNamePool)]
		if i >= len(tableNamePool) {
			name += "_" + strconv.Itoa(i/len(tableNamePool))
		}
		w := int64(1 + r.Intn(9))
		ns.tbl[name] = newTable(wh, ns.levels, name, records*w/int64(5*count)+1, size*w/int64(5*count)+1, i)
	}
	if count > 0 {
		first := tableNamePool[start%len(tableNamePool)]
		ns.views["revenue_by_customer"] = newView(wh, ns.levels, "revenue_by_customer", strings.Join(ns.levels, ".")+"."+first)
	}
	ns.recompute()
}

func (ns *nsState) recompute() {
	ns.tables, ns.records, ns.size = len(ns.tbl), 0, 0
	for _, t := range ns.tbl {
		ns.records += t.records
		ns.size += t.size
	}
}

// ---------------------------------------------------------------- handlers

func withRefSnapshotsOnly(md map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range md {
		out[k] = v
	}
	keep := map[any]bool{}
	for _, ref := range md["refs"].(map[string]any) {
		keep[ref.(map[string]any)["snapshot-id"]] = true
	}
	var snaps []any
	for _, s := range md["snapshots"].([]any) {
		if keep[s.(map[string]any)["snapshot-id"]] {
			snaps = append(snaps, s)
		}
	}
	out["snapshots"] = snaps
	return out
}

// previewRows produces Arrow-typed rows matching the current schema.
func previewRows(t *tableState, limit int) map[string]any {
	md := t.metadata
	var cur []map[string]any
	for _, sc := range arr(md["schemas"]) {
		if numEq(obj(sc)["schema-id"], md["current-schema-id"]) {
			cur = fieldsOf(obj(sc)["fields"])
		}
	}
	r := seeded(t.uuid, "preview")
	var cols []any
	for _, f := range cur {
		cols = append(cols, map[string]any{"name": f["name"], "type": arrowType(f["type"])})
	}
	n := int(min(int64(limit), max(t.records, 0)))
	if len(arr(md["snapshots"])) == 0 {
		n = 0
	}
	rows := make([]any, 0, n)
	base := time.Now().Add(-72 * time.Hour)
	for i := 0; i < n; i++ {
		row := make([]any, 0, len(cur))
		for _, f := range cur {
			row = append(row, sampleValue(f["name"].(string), f["type"], r, i, base))
		}
		rows = append(rows, row)
	}
	return map[string]any{"schema": cols, "rows": rows, "row_count": len(rows)}
}

func arrowType(t any) string {
	switch v := t.(type) {
	case string:
		switch {
		case v == "long":
			return "int64"
		case v == "int":
			return "int32"
		case v == "double":
			return "double"
		case v == "float":
			return "float"
		case v == "boolean":
			return "bool"
		case v == "timestamptz":
			return "timestamp[us, tz=UTC]"
		case v == "timestamp":
			return "timestamp[us]"
		case strings.HasPrefix(v, "decimal"):
			return "decimal128" + strings.TrimPrefix(v, "decimal")
		case v == "uuid", strings.HasPrefix(v, "fixed"):
			return "fixed_size_binary[16]"
		}
		return v
	case map[string]any:
		switch v["type"] {
		case "list":
			return "list<" + arrowType(v["element"]) + ">"
		case "map":
			return "map<" + arrowType(v["key"]) + ", " + arrowType(v["value"]) + ">"
		case "struct":
			var parts []string
			for _, f := range fieldsOf(v["fields"]) {
				parts = append(parts, fmt.Sprintf("%s: %s", f["name"], arrowType(f["type"])))
			}
			return "struct<" + strings.Join(parts, ", ") + ">"
		}
	}
	return "unknown"
}

var (
	cities    = []string{"Warsaw", "Berlin", "Lisbon", "Austin", "Osaka", "Toronto", "Nairobi"}
	countries = []string{"PL", "DE", "PT", "US", "JP", "CA", "KE"}
	statusVal = []string{"placed", "paid", "shipped", "delivered", "cancelled"}
)

func sampleValue(name string, t any, r *rand.Rand, i int, base time.Time) any {
	if r.Intn(40) == 0 && name != "order_id" && name != "event_id" && name != "entity_id" {
		return nil
	}
	switch v := t.(type) {
	case string:
		switch {
		case v == "long":
			if strings.HasSuffix(name, "_id") {
				return int64(9007199254740993) + int64(i)*7919 // beyond 2^53
			}
			return r.Int63n(1_000_000)
		case v == "int":
			return r.Intn(100)
		case v == "double" || v == "float":
			return float64(r.Intn(1_000_000)) / 1000
		case v == "boolean":
			return r.Intn(2) == 0
		case v == "string":
			switch {
			case strings.Contains(name, "status"):
				return statusVal[r.Intn(len(statusVal))]
			case name == "city":
				return cities[r.Intn(len(cities))]
			case name == "country":
				return countries[r.Intn(len(countries))]
			case name == "channel":
				return []string{"web", "store", "app"}[r.Intn(3)]
			}
			return fmt.Sprintf("%s-%05d", strings.TrimSuffix(name, "_id"), r.Intn(99999))
		case v == "timestamp" || v == "timestamptz":
			return base.Add(time.Duration(i) * 97 * time.Second).UTC().Format("2006-01-02T15:04:05.000000Z")
		case strings.HasPrefix(v, "decimal"):
			return fmt.Sprintf("%d.%02d", r.Intn(5000), r.Intn(100))
		case v == "uuid" || strings.HasPrefix(v, "fixed"):
			return fakeUUID(fmt.Sprint(name, i))
		case v == "binary":
			return "0a0b0c0d"
		}
	case map[string]any:
		switch v["type"] {
		case "list":
			n := 1 + r.Intn(3)
			out := make([]any, 0, n)
			for j := 0; j < n; j++ {
				out = append(out, sampleValue("element", v["element"], r, i*10+j, base))
			}
			return out
		case "map":
			return map[string]any{"source": "import", "tier": []string{"gold", "silver"}[r.Intn(2)]}
		case "struct":
			out := map[string]any{}
			for _, f := range fieldsOf(v["fields"]) {
				out[f["name"].(string)] = sampleValue(f["name"].(string), f["type"], r, i, base)
			}
			return out
		}
	}
	return nil
}

// rename moves a table or view between namespaces of a warehouse.
func (c *Catalog) rename(w http.ResponseWriter, r *http.Request, wh *whState, kind string) {
	var body struct {
		Source      identifierJSON `json:"source"`
		Destination identifierJSON `json:"destination"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	src, ok1 := wh.namespaces[strings.Join(body.Source.Namespace, "\x1f")]
	dst, ok2 := wh.namespaces[strings.Join(body.Destination.Namespace, "\x1f")]
	if !ok1 || !ok2 {
		iceErr(w, 404, "NoSuchNamespaceException", "namespace does not exist")
		return
	}
	if kind == "table" {
		t, ok := src.tbl[body.Source.Name]
		if !ok {
			iceErr(w, 404, "NoSuchTableException", "table does not exist: "+body.Source.Name)
			return
		}
		if dst.tbl == nil {
			dst.tbl = map[string]*tableState{}
		}
		if _, exists := dst.tbl[body.Destination.Name]; exists {
			iceErr(w, 409, "AlreadyExistsException", "table already exists: "+body.Destination.Name)
			return
		}
		delete(src.tbl, body.Source.Name)
		t.name = body.Destination.Name
		dst.tbl[body.Destination.Name] = t
		src.recompute()
		dst.recompute()
	} else {
		v, ok := src.views[body.Source.Name]
		if !ok {
			iceErr(w, 404, "NoSuchViewException", "view does not exist: "+body.Source.Name)
			return
		}
		if dst.views == nil {
			dst.views = map[string]*viewState{}
		}
		delete(src.views, body.Source.Name)
		v.name = body.Destination.Name
		dst.views[body.Destination.Name] = v
	}
	w.WriteHeader(204)
}

type identifierJSON struct {
	Namespace []string `json:"namespace"`
	Name      string   `json:"name"`
}
