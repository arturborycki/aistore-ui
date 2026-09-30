package semantic

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
)

// Column is one addressable column of an Iceberg table. Struct leaves are
// addressed by dotted paths ("shipping.city"); lists and maps are opaque.
type Column struct {
	ID       int    `json:"id"`
	Path     string `json:"path"`
	Type     string `json:"type"`     // Iceberg type label, e.g. long, decimal(12, 2), list<string>
	Required bool   `json:"required"` // required including all ancestors
	Doc      string `json:"doc,omitempty"`
	Nested   bool   `json:"nested,omitempty"` // a list or map (whole value)
}

// TableInfo is what the semantic layer needs to know about an Iceberg table.
type TableInfo struct {
	UUID          string   `json:"uuid"`
	Warehouse     string   `json:"warehouse"`
	Namespace     []string `json:"namespace"`
	Name          string   `json:"name"`
	SchemaID      int      `json:"schemaId"`
	Columns       []Column `json:"columns"`
	IdentifierIDs []int    `json:"identifierIds,omitempty"`
	Comment       string   `json:"comment,omitempty"`
}

func (t *TableInfo) ByPath(p string) *Column {
	for i := range t.Columns {
		if strings.EqualFold(t.Columns[i].Path, p) {
			return &t.Columns[i]
		}
	}
	return nil
}

func (t *TableInfo) ByID(id int) *Column {
	for i := range t.Columns {
		if t.Columns[i].ID == id {
			return &t.Columns[i]
		}
	}
	return nil
}

// Label is warehouse.ns.table for messages.
func (t *TableInfo) Label() string {
	return t.Warehouse + "." + strings.Join(t.Namespace, ".") + "." + t.Name
}

type icebergField struct {
	ID       int             `json:"id"`
	Name     string          `json:"name"`
	Required bool            `json:"required"`
	Type     json.RawMessage `json:"type"`
	Doc      string          `json:"doc"`
}

// ParseTable extracts TableInfo from a loadTable response ({"metadata": …}).
func ParseTable(warehouse string, namespace []string, name string, loadResult []byte) (*TableInfo, error) {
	var lr struct {
		Metadata struct {
			UUID            string `json:"table-uuid"`
			CurrentSchemaID int    `json:"current-schema-id"`
			Schemas         []struct {
				SchemaID      int            `json:"schema-id"`
				Fields        []icebergField `json:"fields"`
				IdentifierIDs []int          `json:"identifier-field-ids"`
			} `json:"schemas"`
			Properties map[string]string `json:"properties"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal(loadResult, &lr); err != nil {
		return nil, fmt.Errorf("table metadata: %w", err)
	}
	md := lr.Metadata
	t := &TableInfo{UUID: md.UUID, Warehouse: warehouse, Namespace: namespace, Name: name, SchemaID: md.CurrentSchemaID, Comment: md.Properties["comment"]}
	for _, s := range md.Schemas {
		if s.SchemaID != md.CurrentSchemaID {
			continue
		}
		t.IdentifierIDs = s.IdentifierIDs
		flatten(s.Fields, "", true, &t.Columns)
	}
	return t, nil
}

func flatten(fields []icebergField, prefix string, parentRequired bool, out *[]Column) {
	for _, f := range fields {
		path := f.Name
		if prefix != "" {
			path = prefix + "." + f.Name
		}
		var prim string
		if json.Unmarshal(f.Type, &prim) == nil {
			*out = append(*out, Column{ID: f.ID, Path: path, Type: prim, Required: f.Required && parentRequired, Doc: f.Doc})
			continue
		}
		var nt struct {
			Type   string         `json:"type"`
			Fields []icebergField `json:"fields"`
		}
		_ = json.Unmarshal(f.Type, &nt)
		if nt.Type == "struct" {
			flatten(nt.Fields, path, f.Required && parentRequired, out)
			continue
		}
		*out = append(*out, Column{ID: f.ID, Path: path, Type: typeLabel(f.Type), Required: f.Required && parentRequired, Doc: f.Doc, Nested: true})
	}
}

func typeLabel(raw json.RawMessage) string {
	var prim string
	if json.Unmarshal(raw, &prim) == nil {
		return prim
	}
	var t struct {
		Type    string          `json:"type"`
		Element json.RawMessage `json:"element"`
		Key     json.RawMessage `json:"key"`
		Value   json.RawMessage `json:"value"`
	}
	_ = json.Unmarshal(raw, &t)
	switch t.Type {
	case "list":
		return "list<" + typeLabel(t.Element) + ">"
	case "map":
		return "map<" + typeLabel(t.Key) + ", " + typeLabel(t.Value) + ">"
	case "struct":
		return "struct<…>"
	}
	return t.Type
}

var decimalRe = regexp.MustCompile(`^decimal\(`)

// OssieType maps an Iceberg type label to an Ossie datatype.
func OssieType(iceberg string) string {
	switch {
	case iceberg == "boolean":
		return "Boolean"
	case iceberg == "int" || iceberg == "long":
		return "Integer"
	case iceberg == "float" || iceberg == "double":
		return "Float"
	case decimalRe.MatchString(iceberg):
		return "Decimal"
	case iceberg == "date":
		return "Date"
	case iceberg == "time":
		return "Time"
	case iceberg == "timestamp" || iceberg == "timestamp_ns":
		return "DateTime"
	case iceberg == "timestamptz" || iceberg == "timestamptz_ns":
		return "DateTimeTz"
	case iceberg == "string" || iceberg == "uuid":
		return "String"
	}
	return "Opaque"
}

func isTemporal(ossie string) bool {
	return ossie == "Date" || ossie == "Time" || ossie == "DateTime" || ossie == "DateTimeTz"
}

// SourceFormatter renders a dataset's `source` for a table.
type SourceFormatter func(warehouse string, namespace []string, table string) string

// DefaultSource renders {alias-or-warehouse}.{ns levels}.{table}.
func DefaultSource(aliases map[string]string) SourceFormatter {
	return func(wh string, ns []string, table string) string {
		cat := wh
		if a := aliases[wh]; a != "" {
			cat = a
		}
		parts := append([]string{cat}, ns...)
		parts = append(parts, table)
		for i, p := range parts {
			parts[i] = quoteIdent(p)
		}
		return strings.Join(parts, ".")
	}
}

var nameCleaner = regexp.MustCompile(`[^A-Za-z0-9_]+`)

// FieldName turns a column path into a field name (shipping.city → shipping_city).
func FieldName(path string) string {
	n := strings.Trim(nameCleaner.ReplaceAllString(path, "_"), "_")
	if n == "" {
		n = "field"
	}
	return n
}

// FieldFromColumn builds an Ossie field for a column.
func FieldFromColumn(c Column) Field {
	dt := OssieType(c.Type)
	if c.Nested {
		dt = "Opaque"
	}
	f := Field{Name: FieldName(c.Path), Expression: Simple(columnExpr(c.Path)), Datatype: dt, Description: c.Doc}
	f.SetExt(FieldExt{FieldID: c.ID, IcebergType: c.Type})
	return f
}

func columnExpr(path string) string {
	parts := strings.Split(path, ".")
	for i, p := range parts {
		parts[i] = quoteIdent(p)
	}
	return strings.Join(parts, ".")
}

// GenerateDataset builds a dataset for a table: every column becomes a
// field, the row key becomes the primary key, docs become descriptions.
func GenerateDataset(t *TableInfo, name string, source SourceFormatter) Dataset {
	d := Dataset{Name: name, Source: source(t.Warehouse, t.Namespace, t.Name), Description: t.Comment}
	used := map[string]bool{}
	for _, c := range t.Columns {
		f := FieldFromColumn(c)
		base := f.Name
		for i := 2; used[f.Name]; i++ {
			f.Name = fmt.Sprintf("%s_%d", base, i)
		}
		used[f.Name] = true
		d.Fields = append(d.Fields, f)
	}
	for _, id := range t.IdentifierIDs {
		for _, f := range d.Fields {
			if x, ok := f.Ext(); ok && x.FieldID == id {
				d.PrimaryKey = append(d.PrimaryKey, f.Name)
			}
		}
	}
	sid := t.SchemaID
	d.SetExt(DatasetExt{TableUUID: t.UUID, Warehouse: t.Warehouse, Namespace: t.Namespace, Table: t.Name, SchemaID: &sid})
	return d
}

// UniqueDatasetName picks a dataset name not used in m.
func UniqueDatasetName(m *Model, want string) string {
	name := FieldName(want)
	base := name
	for i := 2; m.Dataset(name) != nil; i++ {
		name = fmt.Sprintf("%s_%d", base, i)
	}
	return name
}
