package server

import (
	"net/http"
	"strings"
	"testing"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
)

func TestInspectTableFilesAndColumnStats(t *testing.T) {
	e := newEnv(t, false)
	cat := aistortest.NewCatalog()
	cat.Seed("shop", nil, map[string][3]int64{"sales": {2, 100000, 1 << 20}})
	e.fake.Handler = func(w http.ResponseWriter, r *http.Request, _ string) { cat.Handle(w, r) }
	objs := aistortest.NewObjectStore()
	if err := cat.WriteManifests(objs); err != nil {
		t.Fatal(err)
	}
	e.fake.Objects = objs
	// bob may read the catalog but not the warehouse bucket's files.
	e.fake.SetAllowed("bob", []string{"GET /warehouses", "GET /shop/*"})
	alice, bob := e.browser(), e.browser()
	alice.login("alice", "alice-pw")
	bob.login("bob", "bob-pw")

	_, list := alice.do("GET", "/api/c/dev/wh/shop/ns/sales/tables", "")
	name := list["identifiers"].([]any)[0].(map[string]any)["name"].(string)
	path := "/api/c/dev/wh/shop/ns/sales/t/" + name + "/inspect"
	resp, out := alice.do("GET", path+"?files=3", "")
	if resp.StatusCode != 200 {
		t.Fatalf("inspect: %d %v", resp.StatusCode, out)
	}
	sum := out["summary"].(map[string]any)
	if sum["dataFiles"].(float64) == 0 || sum["records"].(float64) == 0 || sum["manifests"].(float64) == 0 {
		t.Fatalf("empty summary: %v", sum)
	}
	if len(out["files"].([]any)) != 3 || out["filesTruncated"] != true {
		t.Fatalf("files limit: %d %v", len(out["files"].([]any)), out["filesTruncated"])
	}
	cols := out["columns"].([]any)
	first := cols[0].(map[string]any)
	if first["valueCount"] == nil || first["lower"] == nil || first["upper"] == nil {
		t.Fatalf("column stats missing: %v", first)
	}
	if parts := out["partitions"].([]any); len(parts) == 0 || !strings.Contains(toJSON(parts[0]), "ts_day") {
		t.Fatalf("partitions: %v", parts)
	}
	// An older snapshot has fewer records.
	_, md := alice.do("GET", "/api/c/dev/wh/shop/ns/sales/t/"+name, "")
	snaps := md["metadata"].(map[string]any)["snapshots"].([]any)
	oldID := toJSON(snaps[0].(map[string]any)["snapshot-id"])
	_, old := alice.do("GET", path+"?snapshot="+oldID, "")
	if old["summary"].(map[string]any)["records"].(float64) >= sum["records"].(float64) {
		t.Fatalf("time travel: old %v, current %v", old["summary"], sum)
	}
	// Reading files uses the caller's credentials: bob gets a clear 403, also from cache.
	resp, out = bob.do("GET", path+"?files=3", "")
	if resp.StatusCode != 403 || resp.Header.Get("X-Aistor-Action") != "s3:GetObject" {
		t.Fatalf("bob: %d %v", resp.StatusCode, out)
	}
	if resp, _ := bob.do("GET", path+"?snapshot=abc", ""); resp.StatusCode != 400 {
		t.Fatalf("bad snapshot id accepted: %d", resp.StatusCode)
	}
}
