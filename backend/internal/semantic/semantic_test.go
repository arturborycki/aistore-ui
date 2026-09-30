package semantic

import (
	"os"
	"strings"
	"testing"
)

func mustParse(t *testing.T, doc string) *Model {
	t.Helper()
	m, ps, err := Parse([]byte(doc), DefaultLimits)
	if err != nil || len(ps) > 0 {
		t.Fatalf("parse: %v %v", err, ps)
	}
	return m
}

func TestUpstreamExampleConforms(t *testing.T) {
	raw, err := os.ReadFile("testdata/tpcds_semantic_model.yaml")
	if err != nil {
		t.Fatal(err)
	}
	m := mustParse(t, string(raw))
	if len(m.Datasets) < 5 || len(m.Metrics) == 0 || len(m.Relationships) == 0 {
		t.Fatalf("example not fully decoded: %d datasets, %d metrics", len(m.Datasets), len(m.Metrics))
	}
	for _, p := range Validate(m) {
		if p.Severity == "error" {
			t.Errorf("upstream example flagged: %+v", p)
		}
	}
	// Canonical output is stable and re-parses to the same model.
	a, _ := MarshalYAML(m)
	b, _ := MarshalYAML(mustParse(t, string(a)))
	if string(a) != string(b) {
		t.Fatal("canonical YAML is not stable across a round trip")
	}
	j, _ := MarshalJSON(m)
	c, _ := MarshalYAML(mustParse(t, string(j)))
	if string(a) != string(c) {
		t.Fatal("JSON and YAML forms differ")
	}
}

func TestSchemaAndSafetyChecks(t *testing.T) {
	cases := map[string]string{
		"missing datasets":   "version: \"0.2.0.dev0\"\nname: x\n",
		"wrong version":      "version: \"0.1.1\"\nname: x\ndatasets: [{name: a, source: a.b.c}]\n",
		"unknown key":        "version: \"0.2.0.dev0\"\nname: x\nowner: me\ndatasets: [{name: a, source: a.b.c}]\n",
		"bad dialect":        "version: \"0.2.0.dev0\"\nname: x\ndatasets: [{name: a, source: a.b.c, fields: [{name: f, expression: {dialects: [{dialect: SPARK, expression: f}]}}]}]\n",
		"numeric version":    "version: 0.2\nname: x\ndatasets: [{name: a, source: a.b.c}]\n",
		"bad datatype":       "version: \"0.2.0.dev0\"\nname: x\ndatasets: [{name: a, source: a.b.c, fields: [{name: f, datatype: Text, expression: {dialects: [{dialect: ANSI_SQL, expression: f}]}}]}]\n",
		"empty dialect list": "version: \"0.2.0.dev0\"\nname: x\ndatasets: [{name: a, source: a.b.c, fields: [{name: f, expression: {dialects: []}}]}]\n",
	}
	for name, doc := range cases {
		m, ps, err := Parse([]byte(doc), DefaultLimits)
		if err == nil && len(ps) == 0 {
			t.Errorf("%s: accepted (%v)", name, m)
		}
	}
	bombs := map[string]string{
		"alias":     "version: &v \"0.2.0.dev0\"\nname: *v\ndatasets: []\n",
		"merge":     "version: \"0.2.0.dev0\"\nname: x\ndatasets:\n  - <<: {name: a}\n    source: s\n",
		"two docs":  "version: \"0.2.0.dev0\"\n---\nname: x\n",
		"dup key":   "version: \"0.2.0.dev0\"\nname: x\nname: y\ndatasets: []\n",
		"not a map": "- a\n- b\n",
		"too big":   strings.Repeat("#", DefaultLimits.MaxBytes+1),
	}
	for name, doc := range bombs {
		if _, _, err := Parse([]byte(doc), DefaultLimits); err == nil {
			t.Errorf("%s: not rejected", name)
		}
	}
}

func TestRefsAndRewrite(t *testing.T) {
	refs := Refs(`SUM(orders.amount) - COALESCE(SUM("returns"."amt"), 0) /* orders.x */ + 'orders.y' -- c.d`)
	var got []string
	for _, r := range refs {
		if !r.Call {
			got = append(got, strings.Join(r.Parts, "."))
		}
	}
	if strings.Join(got, ",") != "orders.amount,returns.amt" {
		t.Fatalf("refs: %v", got)
	}
	out := ReplaceRefs(`SUM(orders.amount) + orders.amount_x`, func(r Ref) []string {
		if len(r.Parts) == 2 && r.Parts[0] == "orders" && r.Parts[1] == "amount" {
			return []string{"orders", "net amount"}
		}
		return nil
	})
	if out != `SUM(orders."net amount") + orders.amount_x` {
		t.Fatalf("rewrite: %s", out)
	}
	if p, ok := SimpleColumn(" shipping.city "); !ok || p != "shipping.city" {
		t.Fatalf("simple: %q %v", p, ok)
	}
	for _, e := range []string{"a + b", "upper(a)", "CASE WHEN a THEN 1 END", "null"} {
		if _, ok := SimpleColumn(e); ok {
			t.Errorf("%q treated as a column", e)
		}
	}
	if parts, ok := ParseSource(`analytics."sales".orders`); !ok || strings.Join(parts, "/") != "analytics/sales/orders" {
		t.Fatalf("source: %v", parts)
	}
	if _, ok := ParseSource("SELECT * FROM t"); ok {
		t.Fatal("query treated as a table")
	}
}

const orders = `{"metadata":{"table-uuid":"u-orders","current-schema-id":1,"properties":{"comment":"All orders"},"schemas":[
 {"schema-id":0,"fields":[{"id":1,"name":"id","required":true,"type":"long"}]},
 {"schema-id":1,"identifier-field-ids":[1],"fields":[
  {"id":1,"name":"order_id","required":true,"type":"long","doc":"Order key"},
  {"id":2,"name":"customer_id","required":true,"type":"long"},
  {"id":3,"name":"ts","required":true,"type":"timestamptz"},
  {"id":4,"name":"amount","required":false,"type":"decimal(12, 2)"},
  {"id":5,"name":"shipping","required":false,"type":{"type":"struct","fields":[{"id":6,"name":"city","required":false,"type":"string"}]}},
  {"id":7,"name":"tags","required":false,"type":{"type":"list","element-id":8,"element":"string","element-required":false}}]}]}}`

const customers = `{"metadata":{"table-uuid":"u-cust","current-schema-id":0,"schemas":[{"schema-id":0,"identifier-field-ids":[1],"fields":[
  {"id":1,"name":"customer_id","required":true,"type":"long"},{"id":2,"name":"name","required":false,"type":"string"}]}]}}`

func tables(t *testing.T) (*TableInfo, *TableInfo) {
	o, err := ParseTable("analytics", []string{"sales"}, "orders", []byte(orders))
	if err != nil {
		t.Fatal(err)
	}
	c, _ := ParseTable("analytics", []string{"crm"}, "customers", []byte(customers))
	return o, c
}

func TestGenerateAndValidate(t *testing.T) {
	o, c := tables(t)
	src := DefaultSource(map[string]string{"analytics": "lake"})
	m := &Model{Version: SpecVersion, Name: "retail", Datasets: []Dataset{GenerateDataset(o, "orders", src), GenerateDataset(c, "customers", src)}}
	d := m.Dataset("orders")
	if d.Source != "lake.sales.orders" || d.Description != "All orders" || strings.Join(d.PrimaryKey, ",") != "order_id" {
		t.Fatalf("dataset: %+v", d)
	}
	names := []string{}
	for _, f := range d.Fields {
		names = append(names, f.Name+":"+f.Datatype)
	}
	if strings.Join(names, " ") != "order_id:Integer customer_id:Integer ts:DateTimeTz amount:Decimal shipping_city:String tags:Opaque" {
		t.Fatalf("fields: %v", names)
	}
	if e := d.Field("shipping_city").Expression.Dialects[0].Expression; e != "shipping.city" {
		t.Fatalf("struct leaf expression: %s", e)
	}
	m.Relationships = []Relationship{{Name: "orders_customer", From: "orders", To: "customers", FromColumns: []string{"customer_id"}, ToColumns: []string{"customer_id"}}}
	m.Metrics = []Metric{{Name: "revenue", Expression: Simple("SUM(orders.amount)"), Datatype: "Decimal"}}
	// The generated model is schema-valid and structurally clean.
	b, _ := MarshalYAML(m)
	re := mustParse(t, string(b))
	if ps := Validate(re); HasErrors(ps) {
		t.Fatalf("generated model has errors: %v", ps)
	}
	if ps := CatalogProblems(re, []*TableInfo{o, c}, []string{"", ""}); len(ps) > 0 {
		t.Fatalf("catalog problems on a fresh model: %v", ps)
	}

	bad := clone(re)
	bad.Metrics = append(bad.Metrics, Metric{Name: "revenue", Expression: Simple("SUM(orders.amt) + SUM(nope.x) + (1")})
	bad.Relationships = append(bad.Relationships, Relationship{Name: "r2", From: "orders", To: "ghost", FromColumns: []string{"customer_id", "ts"}, ToColumns: []string{"x"}})
	bad.Datasets[0].Fields = append(bad.Datasets[0].Fields, Field{Name: "ORDER_ID", Expression: Simple("order_id")})
	msgs := []string{}
	for _, p := range Validate(bad) {
		if p.Severity == "error" {
			msgs = append(msgs, p.Message)
		}
	}
	all := strings.Join(msgs, "\n")
	for _, want := range []string{`metric name "revenue" is already used`, `orders has no field "amt"`, `unknown dataset "nope"`, "missing )", `no dataset named "ghost"`, "same number of columns", `field name "ORDER_ID" is already used`} {
		if !strings.Contains(all, want) {
			t.Errorf("missing error %q in:\n%s", want, all)
		}
	}
}

func TestDriftDetectionAndFixes(t *testing.T) {
	o, c := tables(t)
	src := DefaultSource(nil)
	m := &Model{Version: SpecVersion, Name: "retail", Datasets: []Dataset{GenerateDataset(o, "orders", src), GenerateDataset(c, "customers", src)}}
	m.Relationships = []Relationship{{Name: "oc", From: "orders", To: "customers", FromColumns: []string{"customer_id"}, ToColumns: []string{"customer_id"}}}
	m.Metrics = []Metric{{Name: "customers_n", Expression: Simple("COUNT(DISTINCT customers.customer_id)")}}

	// Evolve the tables: rename amount→total, widen customer_id, drop ts,
	// add a column, change the row key; customers was renamed to clients.
	o2 := *o
	o2.SchemaID = 2
	o2.Columns = []Column{
		{ID: 1, Path: "order_id", Type: "long", Required: true},
		{ID: 2, Path: "customer_id", Type: "string", Required: true},
		{ID: 4, Path: "total", Type: "decimal(12, 2)"},
		{ID: 6, Path: "shipping.city", Type: "string"},
		{ID: 7, Path: "tags", Type: "list<string>", Nested: true},
		{ID: 9, Path: "channel", Type: "string"},
	}
	o2.IdentifierIDs = []int{1, 2}
	c2 := *c
	c2.Name = "clients"
	res := []Resolution{{Table: &o2, Tracked: true}, {Table: &c2, Tracked: true, Moved: true}}
	items := DetectDrift(m, res)
	kinds := map[string]bool{}
	for _, it := range items {
		kinds[it.Kind+":"+it.Field] = true
	}
	for _, want := range []string{"column_renamed:amount", "column_dropped:ts", "type_changed:customer_id", "new_columns:", "key_changed:", "table_moved:"} {
		if !kinds[want] {
			t.Errorf("drift %s not detected: %+v", want, items)
		}
	}
	fixed := ApplyFixes(m, res, items, nil, src)
	d := fixed.Dataset("orders")
	if d.Field("ts") != nil || d.Field("channel") == nil {
		t.Fatalf("fields not fixed: %+v", d.Fields)
	}
	if e := d.Field("amount").Expression.Dialects[0].Expression; e != "total" {
		t.Fatalf("rename not applied: %s", e)
	}
	if d.Field("customer_id").Datatype != "String" || strings.Join(d.PrimaryKey, ",") != "order_id,customer_id" {
		t.Fatalf("type/key not fixed: %+v %v", d.Field("customer_id"), d.PrimaryKey)
	}
	if fixed.Dataset("customers").Source != "analytics.crm.clients" {
		t.Fatalf("move not applied: %s", fixed.Dataset("customers").Source)
	}
	// Once fixed, the model matches the catalog: no drift is left.
	if again := DetectDrift(fixed, []Resolution{{Table: &o2, Tracked: true}, {Table: &c2, Tracked: true}}); len(again) != 0 {
		t.Errorf("drift remains after fixing: %+v", again)
	}
	// Dropping a table removes its dataset, relationships and dependent metrics.
	gone := ApplyFixes(m, []Resolution{{Table: o, Tracked: true}, {Tracked: true, Reason: "dropped"}}, DetectDrift(m, []Resolution{{Table: o, Tracked: true}, {Tracked: true, Reason: "dropped"}}), []string{"table_missing:customers:"}, src)
	if gone.Dataset("customers") != nil || len(gone.Relationships) != 0 || len(gone.Metrics) != 0 {
		t.Fatalf("missing table not cleaned up: %+v", gone)
	}
}
