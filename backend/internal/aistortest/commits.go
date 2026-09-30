package aistortest

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// This file implements the write side of the in-memory catalog with Iceberg
// REST semantics: requirements are validated against the current metadata,
// updates are applied to a copy and swapped in atomically, and multi-table
// transactions apply all-or-nothing. Metadata is kept as generic JSON with
// json.Number so 64-bit snapshot IDs are never rounded.

// normalize converts arbitrary Go values into generic JSON (map[string]any,
// []any, json.Number, string, bool, nil).
func normalize(v any) any {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return decodeGeneric(b)
}

func decodeGeneric(b []byte) any {
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.UseNumber()
	var out any
	if err := dec.Decode(&out); err != nil {
		return nil
	}
	return out
}

func deepCopy(m map[string]any) map[string]any { return normalize(m).(map[string]any) }

func num(v any) (int64, bool) {
	switch n := v.(type) {
	case json.Number:
		i, err := n.Int64()
		return i, err == nil
	case int:
		return int64(n), true
	case int64:
		return n, true
	case float64:
		return int64(n), true
	}
	return 0, false
}

func numEq(a, b any) bool {
	x, ok1 := num(a)
	y, ok2 := num(b)
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return ok1 && ok2 && x == y
}

func arr(v any) []any {
	a, _ := v.([]any)
	return a
}

func obj(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

// fieldsOf returns struct fields as generic maps (works for seeded and committed schemas).
func fieldsOf(v any) []map[string]any {
	var out []map[string]any
	switch t := v.(type) {
	case []field:
		for _, f := range t {
			out = append(out, f)
		}
	case []any:
		for _, f := range t {
			if m, ok := f.(map[string]any); ok {
				out = append(out, m)
			}
		}
	}
	return out
}

// errConflict is reported as 409 CommitFailedException; errBad as 400.
type commitErr struct {
	status int
	typ    string
	msg    string
}

func (e *commitErr) Error() string { return e.msg }

func conflict(format string, a ...any) error {
	return &commitErr{409, "CommitFailedException", "Requirement failed: " + fmt.Sprintf(format, a...)}
}

func bad(format string, a ...any) error {
	return &commitErr{400, "BadRequestException", fmt.Sprintf(format, a...)}
}

func writeCommitErr(w http.ResponseWriter, err error) {
	var ce *commitErr
	if errors.As(err, &ce) {
		iceErr(w, ce.status, ce.typ, ce.msg)
		return
	}
	iceErr(w, 500, "ServerError", err.Error())
}

func maxID(items []any, key string) int64 {
	m := int64(-1)
	for _, it := range items {
		if v, ok := num(obj(it)[key]); ok && v > m {
			m = v
		}
	}
	return m
}

func maxFieldIDGeneric(v any) int64 {
	var m int64
	var walk func(any)
	walk = func(x any) {
		switch t := x.(type) {
		case map[string]any:
			for k, v := range t {
				if k == "id" || k == "element-id" || k == "key-id" || k == "value-id" {
					if n, ok := num(v); ok && n > m {
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
	walk(normalize(v))
	return m
}

func checkTableRequirements(md map[string]any, reqs []any) error {
	for _, r := range reqs {
		req := obj(r)
		switch req["type"] {
		case "assert-create":
			return conflict("table already exists")
		case "assert-table-uuid":
			if req["uuid"] != md["table-uuid"] {
				return conflict("table UUID does not match")
			}
		case "assert-current-schema-id":
			if !numEq(req["current-schema-id"], md["current-schema-id"]) {
				return conflict("current schema changed: expected id %v != %v", req["current-schema-id"], md["current-schema-id"])
			}
		case "assert-last-assigned-field-id":
			if !numEq(req["last-assigned-field-id"], md["last-column-id"]) {
				return conflict("last assigned field id changed: expected %v != %v", req["last-assigned-field-id"], md["last-column-id"])
			}
		case "assert-last-assigned-partition-id":
			if !numEq(req["last-assigned-partition-id"], md["last-partition-id"]) {
				return conflict("last assigned partition id changed: expected %v != %v", req["last-assigned-partition-id"], md["last-partition-id"])
			}
		case "assert-default-spec-id":
			if !numEq(req["default-spec-id"], md["default-spec-id"]) {
				return conflict("default partition spec changed: expected %v != %v", req["default-spec-id"], md["default-spec-id"])
			}
		case "assert-default-sort-order-id":
			if !numEq(req["default-sort-order-id"], md["default-sort-order-id"]) {
				return conflict("default sort order changed: expected %v != %v", req["default-sort-order-id"], md["default-sort-order-id"])
			}
		case "assert-ref-snapshot-id":
			name, _ := req["ref"].(string)
			ref := obj(obj(md["refs"])[name])
			want := req["snapshot-id"]
			if want == nil {
				if ref != nil {
					return conflict("reference %q already exists", name)
				}
			} else if ref == nil || !numEq(ref["snapshot-id"], want) {
				return conflict("reference %q has changed", name)
			}
		default:
			return bad("unsupported requirement %v", req["type"])
		}
	}
	return nil
}

func findSnapshot(md map[string]any, id any) map[string]any {
	for _, s := range arr(md["snapshots"]) {
		if numEq(obj(s)["snapshot-id"], id) {
			return obj(s)
		}
	}
	return nil
}

// applyTableUpdates mutates md (a private copy) according to Iceberg MetadataUpdate semantics.
func applyTableUpdates(md map[string]any, updates []any) error {
	lastSchema, lastSpec, lastOrder := int64(-1), int64(-1), int64(-1)
	for _, u := range updates {
		up := obj(u)
		switch up["action"] {
		case "upgrade-format-version":
			v, _ := num(up["format-version"])
			cur, _ := num(md["format-version"])
			if v < cur || v > 3 {
				return bad("cannot change format version from %d to %d", cur, v)
			}
			md["format-version"] = v
		case "add-schema":
			s := obj(up["schema"])
			if s == nil || s["type"] != "struct" {
				return bad("add-schema requires a struct schema")
			}
			for _, f := range fieldsOf(s["fields"]) {
				if f["initial-default"] != nil || f["write-default"] != nil {
					return bad("default column values are not supported")
				}
			}
			if err := validateIdentifiers(s); err != nil {
				return err
			}
			id := maxID(arr(md["schemas"]), "schema-id") + 1
			s["schema-id"] = id
			md["schemas"] = append(arr(md["schemas"]), s)
			if lc := maxFieldIDGeneric(s); lc > mustNum(md["last-column-id"]) {
				md["last-column-id"] = lc
			}
			lastSchema = id
		case "set-current-schema":
			id, _ := num(up["schema-id"])
			if id == -1 {
				id = lastSchema
			}
			if id < 0 || !hasID(arr(md["schemas"]), "schema-id", id) {
				return bad("unknown schema id %v", up["schema-id"])
			}
			md["current-schema-id"] = id
		case "add-spec":
			s := obj(up["spec"])
			if s == nil {
				return bad("add-spec requires a spec")
			}
			id := maxID(arr(md["partition-specs"]), "spec-id") + 1
			s["spec-id"] = id
			if s["fields"] == nil {
				s["fields"] = []any{}
			}
			for _, f := range arr(s["fields"]) {
				if fid, ok := num(obj(f)["field-id"]); ok && fid > mustNum(md["last-partition-id"]) {
					md["last-partition-id"] = fid
				}
			}
			md["partition-specs"] = append(arr(md["partition-specs"]), s)
			lastSpec = id
		case "set-default-spec":
			id, _ := num(up["spec-id"])
			if id == -1 {
				id = lastSpec
			}
			if id < 0 || !hasID(arr(md["partition-specs"]), "spec-id", id) {
				return bad("unknown spec id %v", up["spec-id"])
			}
			md["default-spec-id"] = id
		case "add-sort-order":
			s := obj(up["sort-order"])
			if s == nil {
				return bad("add-sort-order requires a sort order")
			}
			id := maxID(arr(md["sort-orders"]), "order-id") + 1
			if id < 1 {
				id = 1
			}
			if len(arr(s["fields"])) == 0 {
				id = 0 // the unsorted order always has id 0
			}
			s["order-id"] = id
			if !hasID(arr(md["sort-orders"]), "order-id", id) {
				md["sort-orders"] = append(arr(md["sort-orders"]), s)
			}
			lastOrder = id
		case "set-default-sort-order":
			id, _ := num(up["sort-order-id"])
			if id == -1 {
				id = lastOrder
			}
			if id < 0 || !hasID(arr(md["sort-orders"]), "order-id", id) {
				return bad("unknown sort order id %v", up["sort-order-id"])
			}
			md["default-sort-order-id"] = id
		case "set-snapshot-ref":
			name, _ := up["ref-name"].(string)
			if name == "" {
				return bad("ref-name is required")
			}
			if findSnapshot(md, up["snapshot-id"]) == nil {
				return bad("snapshot %v does not exist", up["snapshot-id"])
			}
			typ, _ := up["type"].(string)
			if typ != "branch" && typ != "tag" {
				return bad("ref type must be branch or tag")
			}
			if name == "main" && typ != "branch" {
				return bad("main must be a branch")
			}
			ref := map[string]any{"snapshot-id": up["snapshot-id"], "type": typ}
			for _, k := range []string{"min-snapshots-to-keep", "max-snapshot-age-ms", "max-ref-age-ms"} {
				if up[k] != nil {
					ref[k] = up[k]
				}
			}
			refs := obj(md["refs"])
			if refs == nil {
				refs = map[string]any{}
			}
			refs[name] = ref
			md["refs"] = refs
			if name == "main" {
				md["current-snapshot-id"] = up["snapshot-id"]
				md["snapshot-log"] = append(arr(md["snapshot-log"]), map[string]any{"snapshot-id": up["snapshot-id"], "timestamp-ms": time.Now().UnixMilli()})
			}
		case "remove-snapshot-ref":
			name, _ := up["ref-name"].(string)
			if name == "main" {
				return bad("the main branch cannot be removed")
			}
			refs := obj(md["refs"])
			if refs[name] == nil {
				return bad("reference %q does not exist", name)
			}
			delete(refs, name)
		case "remove-snapshots":
			ids := arr(up["snapshot-ids"])
			if len(ids) == 0 {
				return bad("snapshot-ids is required")
			}
			for _, id := range ids {
				if findSnapshot(md, id) == nil {
					return bad("snapshot %v does not exist", id)
				}
				for name, r := range obj(md["refs"]) {
					if numEq(obj(r)["snapshot-id"], id) {
						return bad("snapshot %v is referenced by %s", id, name)
					}
				}
			}
			drop := func(list []any) []any {
				out := []any{}
				for _, e := range list {
					keep := true
					for _, id := range ids {
						if numEq(obj(e)["snapshot-id"], id) {
							keep = false
						}
					}
					if keep {
						out = append(out, e)
					}
				}
				return out
			}
			md["snapshots"] = drop(arr(md["snapshots"]))
			md["snapshot-log"] = drop(arr(md["snapshot-log"]))
		case "set-properties":
			props := obj(md["properties"])
			if props == nil {
				props = map[string]any{}
				md["properties"] = props
			}
			for k, v := range obj(up["updates"]) {
				props[k] = v
			}
		case "remove-properties":
			props := obj(md["properties"])
			for _, k := range arr(up["removals"]) {
				delete(props, fmt.Sprint(k))
			}
		default:
			return bad("update %v is not implemented by the test catalog", up["action"])
		}
	}
	return nil
}

func mustNum(v any) int64 { n, _ := num(v); return n }

func hasID(items []any, key string, id int64) bool {
	for _, it := range items {
		if v, ok := num(obj(it)[key]); ok && v == id {
			return true
		}
	}
	return false
}

// commitTo validates and applies a commit to t, returning the new metadata (not yet installed).
func commitTo(t *tableState, reqs, updates []any) (map[string]any, error) {
	return commitMD(t.metadata, reqs, updates)
}

func commitMD(base map[string]any, reqs, updates []any) (map[string]any, error) {
	if err := checkTableRequirements(base, reqs); err != nil {
		return nil, err
	}
	next := deepCopy(base)
	if err := applyTableUpdates(next, updates); err != nil {
		return nil, err
	}
	return next, nil
}

func (t *tableState) install(md map[string]any) {
	now := time.Now().UnixMilli()
	md["metadata-log"] = append(arr(md["metadata-log"]), map[string]any{"metadata-file": t.metaLoc, "timestamp-ms": now})
	md["last-updated-ms"] = now
	t.metadata = md
	t.version++
	t.metaLoc = versionedLocation(t.metaLoc, t.version)
}

func versionedLocation(loc string, v int) string {
	i := strings.LastIndex(loc, "/v")
	if i < 0 {
		return loc
	}
	return loc[:i] + "/v" + strconv.Itoa(v) + ".metadata.json"
}

func readGeneric(r *http.Request) (map[string]any, error) {
	var b bytes.Buffer
	if _, err := b.ReadFrom(r.Body); err != nil {
		return nil, err
	}
	m := obj(decodeGeneric(b.Bytes()))
	if m == nil {
		return nil, bad("request body must be a JSON object")
	}
	return m, nil
}

// createTable builds table metadata from an Iceberg CreateTableRequest.
func createTable(wh string, ns []string, body map[string]any) (*tableState, error) {
	name, _ := body["name"].(string)
	schema := obj(body["schema"])
	if name == "" || schema == nil {
		return nil, bad("name and schema are required")
	}
	if body["location"] != nil {
		return nil, bad("custom locations are not supported")
	}
	for _, f := range fieldsOf(schema["fields"]) {
		if f["initial-default"] != nil || f["write-default"] != nil {
			return nil, bad("default column values are not supported")
		}
	}
	schema["schema-id"] = 0
	props := obj(body["properties"])
	if props == nil {
		props = map[string]any{}
	}
	fv := int64(2)
	if v, ok := props["format-version"].(string); ok {
		fv, _ = strconv.ParseInt(v, 10, 64)
		delete(props, "format-version")
	}
	// partition-spec may be an object {fields} (Iceberg REST) or a bare list (AIStor docs).
	var specFields []any
	switch ps := body["partition-spec"].(type) {
	case map[string]any:
		specFields = arr(ps["fields"])
	case []any:
		specFields = ps
	}
	lastPart := int64(999)
	for i, f := range specFields {
		fm := obj(f)
		if _, ok := num(fm["field-id"]); !ok {
			fm["field-id"] = int64(1000 + i)
		}
		if v := mustNum(fm["field-id"]); v > lastPart {
			lastPart = v
		}
	}
	order := obj(body["write-order"])
	orders := []any{map[string]any{"order-id": 0, "fields": []any{}}}
	defaultOrder := int64(0)
	if order != nil && len(arr(order["fields"])) > 0 {
		order["order-id"] = 1
		orders = append(orders, order)
		defaultOrder = 1
	}
	uuid := fakeUUID(wh + "/" + strings.Join(ns, ".") + "/" + name + "/" + strconv.FormatInt(time.Now().UnixNano(), 10))
	loc := fmt.Sprintf("s3://%s/%s/%s", wh, strings.Join(ns, "/"), name)
	md := normalize(map[string]any{
		"format-version": fv, "table-uuid": uuid, "location": loc, "last-sequence-number": 0,
		"last-updated-ms": time.Now().UnixMilli(), "last-column-id": maxFieldIDGeneric(schema),
		"current-schema-id": 0, "schemas": []any{schema},
		"default-spec-id": 0, "partition-specs": []any{map[string]any{"spec-id": 0, "fields": specFields}}, "last-partition-id": lastPart,
		"default-sort-order-id": defaultOrder, "sort-orders": orders,
		"properties": props, "current-snapshot-id": -1, "refs": map[string]any{}, "snapshots": []any{},
		"snapshot-log": []any{}, "metadata-log": []any{},
	}).(map[string]any)
	t := &tableState{name: name, uuid: uuid, metadata: md, version: 1,
		metaLoc: fmt.Sprintf("s3://%s/.aistor-tables/%s/%s/metadata/v1.metadata.json", wh, strings.Join(ns, "/"), name),
		maint: map[string]map[string]any{
			"icebergSnapshotManagement":      {"status": "Not_Yet_Run"},
			"icebergCompaction":              {"status": "Not_Yet_Run"},
			"icebergUnreferencedFileRemoval": {"status": "Not_Yet_Run"},
		},
		maintCfg: defaultTableMaintenance(), tags: map[string]string{}, sse: "AES256"}
	return t, nil
}

func defaultTableMaintenance() map[string]any {
	return map[string]any{
		"icebergCompaction":              map[string]any{"status": "enabled", "settings": map[string]any{"icebergCompaction": map[string]any{"targetFileSizeMB": 512}}},
		"icebergSnapshotManagement":      map[string]any{"status": "enabled", "settings": map[string]any{"icebergSnapshotManagement": map[string]any{"minSnapshotsToKeep": 1, "maxSnapshotAgeHours": 120}}},
		"icebergUnreferencedFileRemoval": map[string]any{"status": "enabled", "settings": map[string]any{"icebergUnreferencedFileRemoval": map[string]any{"unreferencedDays": 3, "nonCurrentDays": 10}}},
	}
}

// maintenanceValue accepts {"value": {...}} (AWS S3 Tables shape) or the bare configuration.
func maintenanceValue(body map[string]any) (map[string]any, error) {
	v := obj(body["value"])
	if v == nil {
		v = body
	}
	st, _ := v["status"].(string)
	if st != "enabled" && st != "disabled" {
		return nil, bad("status must be enabled or disabled")
	}
	return v, nil
}

func encryptionValue(body map[string]any) (map[string]any, error) {
	v := obj(body["encryptionConfiguration"])
	if v == nil {
		v = body
	}
	switch v["sseAlgorithm"] {
	case "AES256":
		delete(v, "kmsKeyArn")
	case "aws:kms":
		if s, _ := v["kmsKeyArn"].(string); s == "" {
			return nil, bad("kmsKeyArn is required for aws:kms")
		}
	default:
		return nil, bad("sseAlgorithm must be AES256 or aws:kms")
	}
	return v, nil
}

func applyTags(tags map[string]string, r *http.Request, q url.Values) error {
	switch r.Method {
	case "POST":
		body, err := readGeneric(r)
		if err != nil {
			return err
		}
		t := obj(body["tags"])
		if t == nil {
			return bad("body must be {\"tags\": {...}}")
		}
		for k, v := range t {
			tags[k] = fmt.Sprint(v)
		}
	case "DELETE":
		for _, k := range q["tagKeys"] {
			delete(tags, k)
		}
	}
	return nil
}

// ---------------------------------------------------------------- views

func createView(wh string, ns []string, body map[string]any) (*viewState, error) {
	name, _ := body["name"].(string)
	schema := obj(body["schema"])
	vv := obj(body["view-version"])
	if name == "" || schema == nil || vv == nil {
		return nil, bad("name, schema and view-version are required")
	}
	if body["location"] != nil {
		return nil, bad("a custom view metadata location is not supported")
	}
	schema["schema-id"] = 0
	vv["version-id"] = 1
	vv["schema-id"] = 0
	if vv["timestamp-ms"] == nil {
		vv["timestamp-ms"] = time.Now().UnixMilli()
	}
	props := obj(body["properties"])
	if props == nil {
		props = map[string]any{}
	}
	uuid := fakeUUID("view:" + wh + "/" + strings.Join(ns, ".") + "/" + name + strconv.FormatInt(time.Now().UnixNano(), 10))
	md := normalize(map[string]any{
		"view-uuid": uuid, "format-version": 1, "location": fmt.Sprintf("s3://%s/%s/%s", wh, strings.Join(ns, "/"), name),
		"current-version-id": 1, "schemas": []any{schema}, "versions": []any{vv},
		"version-log": []any{map[string]any{"version-id": 1, "timestamp-ms": vv["timestamp-ms"]}}, "properties": props,
	}).(map[string]any)
	return &viewState{name: name, metadata: md, metaLoc: fmt.Sprintf("s3://%s/.aistor-tables/%s/%s/metadata/00001.metadata.json", wh, strings.Join(ns, "/"), name)}, nil
}

func commitView(v *viewState, reqs, updates []any) error {
	md := deepCopy(v.metadata)
	for _, r := range reqs {
		req := obj(r)
		if req["type"] != "assert-view-uuid" {
			return bad("unsupported requirement %v", req["type"])
		}
		if req["uuid"] != md["view-uuid"] {
			return conflict("view UUID does not match")
		}
	}
	lastSchema, lastVersion := int64(-1), int64(-1)
	for _, u := range updates {
		up := obj(u)
		switch up["action"] {
		case "add-schema":
			s := obj(up["schema"])
			id := maxID(arr(md["schemas"]), "schema-id") + 1
			s["schema-id"] = id
			md["schemas"] = append(arr(md["schemas"]), s)
			lastSchema = id
		case "add-view-version":
			vv := obj(up["view-version"])
			id := maxID(arr(md["versions"]), "version-id") + 1
			vv["version-id"] = id
			if sid, _ := num(vv["schema-id"]); sid == -1 {
				vv["schema-id"] = lastSchema
			}
			if !hasID(arr(md["schemas"]), "schema-id", mustNum(vv["schema-id"])) {
				return bad("view version references unknown schema %v", vv["schema-id"])
			}
			if vv["timestamp-ms"] == nil {
				vv["timestamp-ms"] = time.Now().UnixMilli()
			}
			md["versions"] = append(arr(md["versions"]), vv)
			lastVersion = id
		case "set-current-view-version":
			id, _ := num(up["view-version-id"])
			if id == -1 {
				id = lastVersion
			}
			if !hasID(arr(md["versions"]), "version-id", id) {
				return bad("unknown view version %v", up["view-version-id"])
			}
			md["current-version-id"] = id
			md["version-log"] = append(arr(md["version-log"]), map[string]any{"version-id": id, "timestamp-ms": time.Now().UnixMilli()})
		case "set-properties":
			props := obj(md["properties"])
			for k, val := range obj(up["updates"]) {
				props[k] = val
			}
		case "remove-properties":
			props := obj(md["properties"])
			for _, k := range arr(up["removals"]) {
				delete(props, fmt.Sprint(k))
			}
		default:
			return bad("view update %v is not implemented by the test catalog", up["action"])
		}
	}
	v.metadata = md
	return nil
}

// ---------------------------------------------------------------- transactions

func (c *Catalog) transaction(w http.ResponseWriter, r *http.Request, wh *whState) {
	body, err := readGeneric(r)
	if err != nil {
		writeCommitErr(w, err)
		return
	}
	type staged struct {
		t  *tableState
		md map[string]any
	}
	var plan []*staged
	byTable := map[*tableState]*staged{}
	for _, ch := range arr(body["table-changes"]) {
		change := obj(ch)
		id := obj(change["identifier"])
		var levels []string
		for _, l := range arr(id["namespace"]) {
			levels = append(levels, fmt.Sprint(l))
		}
		ns := wh.namespaces[strings.Join(levels, "\x1f")]
		name, _ := id["name"].(string)
		if ns == nil || ns.tbl[name] == nil {
			iceErr(w, 404, "NoSuchTableException", "table does not exist: "+strings.Join(append(levels, name), "."))
			return
		}
		t := ns.tbl[name]
		base := t.metadata
		if prev := byTable[t]; prev != nil {
			base = prev.md // several changes to one table apply in order
		}
		md, err := commitMD(base, arr(change["requirements"]), arr(change["updates"]))
		if err != nil {
			writeCommitErr(w, err)
			return
		}
		if prev := byTable[t]; prev != nil {
			prev.md = md
			continue
		}
		st := &staged{t, md}
		byTable[t] = st
		plan = append(plan, st)
	}
	for _, s := range plan {
		s.t.install(s.md)
	}
	w.WriteHeader(204)
}

// validateIdentifiers applies Iceberg's rules for identifier (row key) fields:
// required primitive, not float/double, and only nested in required structs.
func validateIdentifiers(schema map[string]any) error {
	eligible := map[int64]bool{}
	var walk func(fields []map[string]any)
	walk = func(fields []map[string]any) {
		for _, f := range fields {
			req, _ := f["required"].(bool)
			if !req {
				continue
			}
			id, _ := num(f["id"])
			switch t := f["type"].(type) {
			case string:
				if t != "float" && t != "double" {
					eligible[id] = true
				}
			case map[string]any:
				if t["type"] == "struct" {
					walk(fieldsOf(t["fields"]))
				}
			}
		}
	}
	walk(fieldsOf(schema["fields"]))
	for _, v := range arr(schema["identifier-field-ids"]) {
		id, _ := num(v)
		if !eligible[id] {
			return bad("field %d cannot be an identifier field: it must be a required primitive (not float or double) outside lists and maps and not inside an optional struct", id)
		}
	}
	return nil
}
