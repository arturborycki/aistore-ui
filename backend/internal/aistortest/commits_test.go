package aistortest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func call(t *testing.T, c *Catalog, method, path, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(method, "http://x/_iceberg/v1"+path, strings.NewReader(body))
	rec := httptest.NewRecorder()
	c.Handle(rec, req)
	out, _ := decodeGeneric(rec.Body.Bytes()).(map[string]any)
	return rec.Code, out
}

func mdOf(t *testing.T, c *Catalog, table string) map[string]any {
	t.Helper()
	code, out := call(t, c, "GET", "/wh1/namespaces/ns/tables/"+table, "")
	if code != 200 {
		t.Fatalf("load %s: %d %v", table, code, out)
	}
	return obj(out["metadata"])
}

func newTestCatalog(t *testing.T) *Catalog {
	c := NewCatalog()
	c.Seed("wh1", nil, map[string][3]int64{"ns": {2, 1000, 1 << 20}})
	return c
}

func TestCreateTableAndEvolveSchema(t *testing.T) {
	c := newTestCatalog(t)
	code, out := call(t, c, "POST", "/wh1/namespaces/ns/tables", `{"name":"t1","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long","required":true}]},
		"partition-spec":{"fields":[{"name":"id_bucket","transform":"bucket[8]","source-id":1}]},"properties":{"format-version":"3"}}`)
	if code != 200 {
		t.Fatalf("create: %d %v", code, out)
	}
	md := obj(out["metadata"])
	if mustNum(md["format-version"]) != 3 || mustNum(md["last-partition-id"]) != 1000 {
		t.Fatalf("bad metadata: %v", md)
	}
	// Evolve: add a column; stale requirement must conflict.
	commit := func(reqSchemaID int) (int, map[string]any) {
		return call(t, c, "POST", "/wh1/namespaces/ns/tables/t1", `{"requirements":[{"type":"assert-current-schema-id","current-schema-id":`+itoa(reqSchemaID)+`},{"type":"assert-last-assigned-field-id","last-assigned-field-id":1}],
			"updates":[{"action":"add-schema","schema":{"type":"struct","schema-id":1,"fields":[{"id":1,"name":"id","type":"long","required":true},{"id":2,"name":"note","type":"string","required":false}]}},{"action":"set-current-schema","schema-id":-1}]}`)
	}
	if code, out := commit(0); code != 200 {
		t.Fatalf("evolve: %d %v", code, out)
	}
	md = mdOf(t, c, "t1")
	if mustNum(md["current-schema-id"]) != 1 || mustNum(md["last-column-id"]) != 2 {
		t.Fatalf("schema not evolved: %v", md["current-schema-id"])
	}
	if code, _ := commit(0); code != 409 {
		t.Fatalf("stale commit accepted: %d", code)
	}
}

func itoa(i int) string { b, _ := json.Marshal(i); return string(b) }

func TestRollbackKeeps64BitIDsAndRefs(t *testing.T) {
	c := newTestCatalog(t)
	var name string
	for n := range c.warehouses["wh1"].namespaces["ns"].tbl {
		name = n
		break
	}
	md := mdOf(t, c, name)
	snaps := arr(md["snapshots"])
	old := obj(snaps[0])["snapshot-id"].(json.Number)
	cur := md["current-snapshot-id"].(json.Number)
	body := `{"requirements":[{"type":"assert-ref-snapshot-id","ref":"main","snapshot-id":` + cur.String() + `}],
		"updates":[{"action":"set-snapshot-ref","ref-name":"main","type":"branch","snapshot-id":` + old.String() + `}]}`
	if code, out := call(t, c, "POST", "/wh1/namespaces/ns/tables/"+name, body); code != 200 {
		t.Fatalf("rollback: %d %v", code, out)
	}
	md = mdOf(t, c, name)
	if md["current-snapshot-id"].(json.Number).String() != old.String() {
		t.Fatalf("current snapshot %v, want %v", md["current-snapshot-id"], old)
	}
	// Replaying the same commit fails: main no longer points at cur.
	if code, _ := call(t, c, "POST", "/wh1/namespaces/ns/tables/"+name, body); code != 409 {
		t.Fatalf("stale rollback accepted: %d", code)
	}
	// Creating a tag requires that it does not exist yet (snapshot-id null).
	tag := `{"requirements":[{"type":"assert-ref-snapshot-id","ref":"release","snapshot-id":null}],"updates":[{"action":"set-snapshot-ref","ref-name":"release","type":"tag","snapshot-id":` + old.String() + `}]}`
	if code, out := call(t, c, "POST", "/wh1/namespaces/ns/tables/"+name, tag); code != 200 {
		t.Fatalf("tag: %d %v", code, out)
	}
	if code, _ := call(t, c, "POST", "/wh1/namespaces/ns/tables/"+name, tag); code != 409 {
		t.Fatalf("duplicate tag accepted")
	}
}

func TestTransactionIsAtomic(t *testing.T) {
	c := newTestCatalog(t)
	var names []string
	for n := range c.warehouses["wh1"].namespaces["ns"].tbl {
		names = append(names, n)
	}
	a, b := names[0], names[1]
	uuidA := mdOf(t, c, a)["table-uuid"].(string)
	body := `{"table-changes":[
		{"identifier":{"namespace":["ns"],"name":"` + a + `"},"requirements":[{"type":"assert-table-uuid","uuid":"` + uuidA + `"}],"updates":[{"action":"set-properties","updates":{"tx":"1"}}]},
		{"identifier":{"namespace":["ns"],"name":"` + b + `"},"requirements":[{"type":"assert-table-uuid","uuid":"wrong"}],"updates":[{"action":"set-properties","updates":{"tx":"1"}}]}]}`
	if code, _ := call(t, c, "POST", "/wh1/transactions/commit", body); code != 409 {
		t.Fatalf("expected conflict, got %d", code)
	}
	if obj(mdOf(t, c, a)["properties"])["tx"] != nil {
		t.Fatalf("partial transaction applied")
	}
	good := strings.Replace(body, `"uuid":"wrong"`, `"uuid":"`+mdOf(t, c, b)["table-uuid"].(string)+`"`, 1)
	if code, out := call(t, c, "POST", "/wh1/transactions/commit", good); code != 204 {
		t.Fatalf("transaction: %d %v", code, out)
	}
	if obj(mdOf(t, c, a)["properties"])["tx"] != "1" || obj(mdOf(t, c, b)["properties"])["tx"] != "1" {
		t.Fatalf("transaction not applied")
	}
}

func TestViewsAndSettings(t *testing.T) {
	c := newTestCatalog(t)
	code, out := call(t, c, "POST", "/wh1/namespaces/ns/views", `{"name":"v1","schema":{"type":"struct","fields":[{"id":1,"name":"x","type":"int","required":false}]},
		"view-version":{"version-id":1,"timestamp-ms":1,"schema-id":0,"summary":{"engine-name":"ui"},"representations":[{"type":"sql","sql":"select 1 as x","dialect":"spark"}],"default-namespace":["ns"]}}`)
	if code != 200 {
		t.Fatalf("create view: %d %v", code, out)
	}
	uuid := obj(out["metadata"])["view-uuid"].(string)
	code, out = call(t, c, "POST", "/wh1/namespaces/ns/views/v1", `{"requirements":[{"type":"assert-view-uuid","uuid":"`+uuid+`"}],"updates":[
		{"action":"add-view-version","view-version":{"version-id":2,"timestamp-ms":2,"schema-id":0,"summary":{"engine-name":"ui"},"representations":[{"type":"sql","sql":"select 2 as x","dialect":"spark"}],"default-namespace":["ns"]}},
		{"action":"set-current-view-version","view-version-id":-1}]}`)
	if code != 200 || mustNum(obj(out["metadata"])["current-version-id"]) != 2 {
		t.Fatalf("replace view: %d %v", code, out)
	}
	if code, _ := call(t, c, "PUT", "/warehouses/wh1/encryption", `{"encryptionConfiguration":{"sseAlgorithm":"aws:kms"}}`); code != 400 {
		t.Fatalf("kms without key accepted")
	}
	if code, _ := call(t, c, "POST", "/warehouses/wh1/tags", `{"tags":{"team":"a"}}`); code != 204 {
		t.Fatalf("tag warehouse failed")
	}
	req := httptest.NewRequest("DELETE", "http://x/_iceberg/v1/warehouses/wh1/tags?tagKeys=team", nil)
	rec := httptest.NewRecorder()
	c.Handle(rec, req)
	if rec.Code != http.StatusNoContent || c.warehouses["wh1"].tags["team"] != "" {
		t.Fatalf("untag failed")
	}
}

func TestRemoveSnapshotsAndIdentifierFields(t *testing.T) {
	c := newTestCatalog(t)
	var name string
	for n := range c.warehouses["wh1"].namespaces["ns"].tbl {
		name = n
		break
	}
	md := mdOf(t, c, name)
	snaps := arr(md["snapshots"])
	if len(snaps) < 2 {
		t.Fatalf("seed has %d snapshots", len(snaps))
	}
	cur := md["current-snapshot-id"].(json.Number).String()
	old := obj(snaps[0])["snapshot-id"].(json.Number).String()
	path := "/wh1/namespaces/ns/tables/" + name
	// A snapshot referenced by main cannot be removed.
	if code, _ := call(t, c, "POST", path, `{"updates":[{"action":"remove-snapshots","snapshot-ids":[`+cur+`]}]}`); code != 400 {
		t.Fatalf("removed the current snapshot: %d", code)
	}
	if code, out := call(t, c, "POST", path, `{"updates":[{"action":"remove-snapshots","snapshot-ids":[`+old+`]}]}`); code != 200 {
		t.Fatalf("remove: %d %v", code, out)
	}
	md = mdOf(t, c, name)
	if len(arr(md["snapshots"])) != len(snaps)-1 {
		t.Fatalf("snapshot not removed")
	}
	for _, e := range arr(md["snapshot-log"]) {
		if obj(e)["snapshot-id"].(json.Number).String() == old {
			t.Fatalf("snapshot log still lists the removed snapshot")
		}
	}

	schema := func(idents string, required bool) string {
		return `{"updates":[{"action":"add-schema","schema":{"type":"struct","identifier-field-ids":` + idents + `,"fields":[{"id":1,"name":"id","type":"long","required":` + strings.ToLower(strconv.FormatBool(required)) + `},{"id":2,"name":"score","type":"double","required":true}]}}]}`
	}
	c2 := newTestCatalog(t)
	call(t, c2, "POST", "/wh1/namespaces/ns/tables", `{"name":"k","schema":{"type":"struct","fields":[{"id":1,"name":"id","type":"long","required":true},{"id":2,"name":"score","type":"double","required":true}]}}`)
	kp := "/wh1/namespaces/ns/tables/k"
	if code, out := call(t, c2, "POST", kp, schema("[1]", true)); code != 200 {
		t.Fatalf("identifier on required long rejected: %d %v", code, out)
	}
	if code, _ := call(t, c2, "POST", kp, schema("[2]", true)); code != 400 {
		t.Fatalf("double identifier accepted")
	}
	if code, _ := call(t, c2, "POST", kp, schema("[1]", false)); code != 400 {
		t.Fatalf("optional identifier accepted")
	}
}
