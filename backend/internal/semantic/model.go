// Package semantic implements Apache Ossie semantic models for the catalog:
// a typed model of the pinned spec version, strict parsing, validation (the
// official JSON Schema plus structural and catalog checks), canonical
// serialization, generation from Iceberg schemas, drift detection against the
// live catalog, storage as objects in AIStor, and the HTTP APIs that serve them.
package semantic

import (
	"encoding/json"
	"sort"
	"strings"
)

// SpecVersion is the Apache Ossie version this package reads and writes.
const SpecVersion = "0.2.0.dev0"

// VendorName marks the custom extensions this UI writes to track Iceberg
// identity (table UUIDs, field IDs). Other tools ignore them.
const VendorName = "AISTOR_CATALOG"

// Dialects and data types of the pinned spec.
var (
	Dialects  = []string{"ANSI_SQL", "SNOWFLAKE", "MDX", "TABLEAU", "DATABRICKS", "MAQL", "BIGQUERY", "SIGMA", "THOUGHTSPOT", "DAX", "OSSIE_SQL_2026"}
	DataTypes = []string{"String", "Integer", "Decimal", "Float", "Boolean", "Date", "Time", "DateTime", "DateTimeTz", "Opaque"}
)

// sqlDialects are the dialects whose expressions are SQL-like, so column
// references can be extracted and checked.
var sqlDialects = map[string]bool{"ANSI_SQL": true, "SNOWFLAKE": true, "DATABRICKS": true, "BIGQUERY": true, "OSSIE_SQL_2026": true}

// Model is one Ossie document. Field order is the canonical output order.
type Model struct {
	Version          string         `json:"version" yaml:"version"`
	Name             string         `json:"name" yaml:"name"`
	Description      string         `json:"description,omitempty" yaml:"description,omitempty"`
	AIContext        any            `json:"ai_context,omitempty" yaml:"ai_context,omitempty"`
	Datasets         []Dataset      `json:"datasets" yaml:"datasets"`
	Relationships    []Relationship `json:"relationships,omitempty" yaml:"relationships,omitempty"`
	Metrics          []Metric       `json:"metrics,omitempty" yaml:"metrics,omitempty"`
	CustomExtensions []Extension    `json:"custom_extensions,omitempty" yaml:"custom_extensions,omitempty"`
}

type Dataset struct {
	Name             string      `json:"name" yaml:"name"`
	Source           string      `json:"source" yaml:"source"`
	PrimaryKey       []string    `json:"primary_key,omitempty" yaml:"primary_key,omitempty,flow"`
	UniqueKeys       [][]string  `json:"unique_keys,omitempty" yaml:"unique_keys,omitempty"`
	Description      string      `json:"description,omitempty" yaml:"description,omitempty"`
	AIContext        any         `json:"ai_context,omitempty" yaml:"ai_context,omitempty"`
	Fields           []Field     `json:"fields,omitempty" yaml:"fields,omitempty"`
	CustomExtensions []Extension `json:"custom_extensions,omitempty" yaml:"custom_extensions,omitempty"`
}

type Field struct {
	Name             string      `json:"name" yaml:"name"`
	Expression       Expression  `json:"expression" yaml:"expression"`
	Dimension        *Dimension  `json:"dimension,omitempty" yaml:"dimension,omitempty"`
	Label            string      `json:"label,omitempty" yaml:"label,omitempty"`
	Description      string      `json:"description,omitempty" yaml:"description,omitempty"`
	Datatype         string      `json:"datatype,omitempty" yaml:"datatype,omitempty"`
	AIContext        any         `json:"ai_context,omitempty" yaml:"ai_context,omitempty"`
	CustomExtensions []Extension `json:"custom_extensions,omitempty" yaml:"custom_extensions,omitempty"`
}

type Dimension struct {
	IsTime *bool `json:"is_time,omitempty" yaml:"is_time,omitempty"`
}

type Relationship struct {
	Name             string      `json:"name" yaml:"name"`
	From             string      `json:"from" yaml:"from"`
	To               string      `json:"to" yaml:"to"`
	FromColumns      []string    `json:"from_columns" yaml:"from_columns,flow"`
	ToColumns        []string    `json:"to_columns" yaml:"to_columns,flow"`
	AIContext        any         `json:"ai_context,omitempty" yaml:"ai_context,omitempty"`
	CustomExtensions []Extension `json:"custom_extensions,omitempty" yaml:"custom_extensions,omitempty"`
}

type Metric struct {
	Name             string      `json:"name" yaml:"name"`
	Expression       Expression  `json:"expression" yaml:"expression"`
	Description      string      `json:"description,omitempty" yaml:"description,omitempty"`
	Datatype         string      `json:"datatype,omitempty" yaml:"datatype,omitempty"`
	AIContext        any         `json:"ai_context,omitempty" yaml:"ai_context,omitempty"`
	CustomExtensions []Extension `json:"custom_extensions,omitempty" yaml:"custom_extensions,omitempty"`
}

type Expression struct {
	Dialects []DialectExpression `json:"dialects" yaml:"dialects"`
}

type DialectExpression struct {
	Dialect    string `json:"dialect" yaml:"dialect"`
	Expression string `json:"expression" yaml:"expression"`
}

type Extension struct {
	VendorName string `json:"vendor_name" yaml:"vendor_name"`
	Data       string `json:"data" yaml:"data"`
}

// SQL returns the expression for the first SQL-like dialect (ANSI first).
func (e Expression) SQL() (dialect, expr string, ok bool) {
	for _, want := range []string{"ANSI_SQL", "OSSIE_SQL_2026", "DATABRICKS", "SNOWFLAKE", "BIGQUERY"} {
		for _, d := range e.Dialects {
			if d.Dialect == want {
				return d.Dialect, d.Expression, true
			}
		}
	}
	return "", "", false
}

// Simple builds a single ANSI SQL expression.
func Simple(expr string) Expression {
	return Expression{Dialects: []DialectExpression{{Dialect: "ANSI_SQL", Expression: expr}}}
}

// ---------------------------------------------------------------- catalog extensions

// DatasetExt ties a dataset to an Iceberg table.
type DatasetExt struct {
	TableUUID string   `json:"tableUuid"`
	Warehouse string   `json:"warehouse"`
	Namespace []string `json:"namespace"`
	Table     string   `json:"table"`
	SchemaID  *int     `json:"schemaId,omitempty"`
}

// FieldExt ties a field to an Iceberg column.
type FieldExt struct {
	FieldID     int    `json:"fieldId"`
	IcebergType string `json:"icebergType,omitempty"`
}

func findExt(exts []Extension, out any) bool {
	for _, e := range exts {
		if e.VendorName == VendorName && json.Unmarshal([]byte(e.Data), out) == nil {
			return true
		}
	}
	return false
}

func setExt(exts []Extension, v any) []Extension {
	b, _ := json.Marshal(v)
	out := make([]Extension, 0, len(exts)+1)
	done := false
	for _, e := range exts {
		if e.VendorName == VendorName {
			if !done {
				out = append(out, Extension{VendorName: VendorName, Data: string(b)})
				done = true
			}
			continue
		}
		out = append(out, e)
	}
	if !done {
		out = append(out, Extension{VendorName: VendorName, Data: string(b)})
	}
	return out
}

func (d *Dataset) Ext() (DatasetExt, bool) {
	var x DatasetExt
	ok := findExt(d.CustomExtensions, &x) && x.TableUUID != ""
	return x, ok
}

func (d *Dataset) SetExt(x DatasetExt) { d.CustomExtensions = setExt(d.CustomExtensions, x) }

func (f *Field) Ext() (FieldExt, bool) {
	var x FieldExt
	ok := findExt(f.CustomExtensions, &x) && x.FieldID > 0
	return x, ok
}

func (f *Field) SetExt(x FieldExt) { f.CustomExtensions = setExt(f.CustomExtensions, x) }

// ---------------------------------------------------------------- lookups

func (m *Model) Dataset(name string) *Dataset {
	for i := range m.Datasets {
		if m.Datasets[i].Name == name {
			return &m.Datasets[i]
		}
	}
	return nil
}

func (d *Dataset) Field(name string) *Field {
	for i := range d.Fields {
		if d.Fields[i].Name == name {
			return &d.Fields[i]
		}
	}
	return nil
}

// AIContextText flattens an ai_context value (string or object) into search text.
func AIContextText(v any) []string {
	switch t := v.(type) {
	case string:
		return []string{t}
	case map[string]any:
		var out []string
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			switch x := t[k].(type) {
			case string:
				out = append(out, x)
			case []any:
				for _, s := range x {
					if str, ok := s.(string); ok {
						out = append(out, str)
					}
				}
			}
		}
		return out
	}
	return nil
}

// Synonyms returns ai_context.synonyms, if any.
func Synonyms(v any) []string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	list, _ := m["synonyms"].([]any)
	out := make([]string, 0, len(list))
	for _, s := range list {
		if str, ok := s.(string); ok {
			out = append(out, str)
		}
	}
	return out
}

func lower(s string) string { return strings.ToLower(s) }
