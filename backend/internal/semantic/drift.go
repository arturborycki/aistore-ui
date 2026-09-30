package semantic

import (
	"fmt"
	"slices"
	"strings"
)

// Resolution is how one dataset maps onto the live catalog.
type Resolution struct {
	Table *TableInfo // nil when the table could not be found
	// Moved is set when the table was found by UUID under another name.
	Moved bool
	// Reason explains a nil Table (e.g. "table was dropped", "source is not a catalog table").
	Reason string
	// Tracked is set when the dataset carries our extension (UUID and field IDs).
	Tracked bool
}

// DriftItem is one difference between a model and the catalog.
type DriftItem struct {
	ID      string `json:"id"`   // stable within a report, used to choose fixes
	Kind    string `json:"kind"` // table_moved | table_missing | untracked | column_renamed | column_dropped | type_changed | new_columns | key_changed | expression_broken
	Dataset string `json:"dataset"`
	Field   string `json:"field,omitempty"`
	Message string `json:"message"`
	Fix     string `json:"fix,omitempty"` // what applying the fix does; empty when it needs a manual edit
}

// DetectDrift compares every dataset with its table.
func DetectDrift(m *Model, res []Resolution) []DriftItem {
	var out []DriftItem
	add := func(kind, ds, field, msg, fix string) {
		out = append(out, DriftItem{ID: fmt.Sprintf("%s:%s:%s", kind, ds, field), Kind: kind, Dataset: ds, Field: field, Message: msg, Fix: fix})
	}
	for i := range m.Datasets {
		d := &m.Datasets[i]
		r := res[i]
		t := r.Table
		if t == nil {
			if r.Tracked {
				add("table_missing", d.Name, "", fmt.Sprintf("The table behind %s no longer exists (%s).", d.Name, r.Reason), "Remove the dataset, its relationships and the metrics that use it")
			}
			continue
		}
		if r.Moved {
			add("table_moved", d.Name, "", fmt.Sprintf("%s was renamed or moved to %s.", d.Name, t.Label()), "Point source at "+t.Label())
		}
		if !r.Tracked {
			add("untracked", d.Name, "", fmt.Sprintf("%s is not linked to table %s by UUID and field IDs, so renames cannot be followed.", d.Name, t.Label()), "Link the dataset and its fields to the table")
		}
		covered := map[int]bool{}
		for k := range d.Fields {
			f := &d.Fields[k]
			x, tracked := f.Ext()
			_, expr, hasSQL := f.Expression.SQL()
			col, simple := "", false
			if hasSQL {
				col, simple = SimpleColumn(expr)
			}
			if !tracked {
				if simple {
					if c := t.ByPath(col); c != nil {
						covered[c.ID] = true
					} else {
						add("expression_broken", d.Name, f.Name, fmt.Sprintf("%s.%s reads column %s, which does not exist in %s.", d.Name, f.Name, col, t.Label()), "")
					}
				}
				continue
			}
			c := t.ByID(x.FieldID)
			if c == nil {
				add("column_dropped", d.Name, f.Name, fmt.Sprintf("The column behind %s.%s (field ID %d) was dropped.", d.Name, f.Name, x.FieldID), "Remove the field and the keys and relationships that use it")
				continue
			}
			covered[c.ID] = true
			if simple && !strings.EqualFold(col, c.Path) {
				add("column_renamed", d.Name, f.Name, fmt.Sprintf("Column %s was renamed to %s.", col, c.Path), "Rewrite the expression to read "+c.Path)
			}
			if x.IcebergType != "" && x.IcebergType != c.Type {
				fix := "Record the new type"
				if f.Datatype != "" && f.Datatype != OssieType(c.Type) && !c.Nested {
					fix = "Set datatype to " + OssieType(c.Type)
				}
				add("type_changed", d.Name, f.Name, fmt.Sprintf("%s changed type from %s to %s.", c.Path, x.IcebergType, c.Type), fix)
			}
		}
		var missing []string
		for _, c := range t.Columns {
			if !covered[c.ID] {
				missing = append(missing, c.Path)
			}
		}
		if len(missing) > 0 {
			add("new_columns", d.Name, "", fmt.Sprintf("%d column(s) of %s are not in the model: %s.", len(missing), t.Label(), strings.Join(missing, ", ")), fmt.Sprintf("Add %d field(s)", len(missing)))
		}
		if len(t.IdentifierIDs) > 0 {
			var want []string
			for _, id := range t.IdentifierIDs {
				for _, f := range d.Fields {
					if x, ok := f.Ext(); ok && x.FieldID == id {
						want = append(want, f.Name)
					}
				}
			}
			if len(want) == len(t.IdentifierIDs) && !sameSet(want, d.PrimaryKey) {
				add("key_changed", d.Name, "", fmt.Sprintf("The table's row key is %s; the dataset's primary key is %s.", strings.Join(want, ", "), orNone(d.PrimaryKey)), "Set primary_key to "+strings.Join(want, ", "))
			}
		}
	}
	return out
}

func orNone(s []string) string {
	if len(s) == 0 {
		return "not set"
	}
	return strings.Join(s, ", ")
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	x := slices.Clone(a)
	y := slices.Clone(b)
	slices.Sort(x)
	slices.Sort(y)
	return slices.Equal(x, y)
}

// ApplyFixes returns a copy of m with the fixes of the chosen drift items
// applied (all fixable items when ids is empty).
func ApplyFixes(m *Model, res []Resolution, items []DriftItem, ids []string, source SourceFormatter) *Model {
	want := map[string]bool{}
	for _, id := range ids {
		want[id] = true
	}
	c := clone(m)
	byName := map[string]int{}
	for i, d := range c.Datasets {
		byName[d.Name] = i
	}
	var dropDatasets []string
	dropFields := map[string][]string{}
	for _, it := range items {
		if it.Fix == "" || (len(ids) > 0 && !want[it.ID]) {
			continue
		}
		i, ok := byName[it.Dataset]
		if !ok {
			continue
		}
		d := &c.Datasets[i]
		t := res[i].Table
		switch it.Kind {
		case "table_missing":
			dropDatasets = append(dropDatasets, d.Name)
		case "table_moved":
			d.Source = source(t.Warehouse, t.Namespace, t.Name)
			link(d, t)
		case "untracked":
			link(d, t)
		case "column_dropped":
			dropFields[d.Name] = append(dropFields[d.Name], it.Field)
		case "column_renamed":
			if f := d.Field(it.Field); f != nil {
				if x, ok := f.Ext(); ok {
					if col := t.ByID(x.FieldID); col != nil {
						f.Expression = rewriteSQL(f.Expression, columnExpr(col.Path))
					}
				}
			}
		case "type_changed":
			if f := d.Field(it.Field); f != nil {
				if x, ok := f.Ext(); ok {
					if col := t.ByID(x.FieldID); col != nil {
						if f.Datatype != "" && !col.Nested {
							f.Datatype = OssieType(col.Type)
						}
						x.IcebergType = col.Type
						f.SetExt(x)
					}
				}
			}
		case "new_columns":
			covered := map[int]bool{}
			names := map[string]bool{}
			for _, f := range d.Fields {
				names[lower(f.Name)] = true
				if x, ok := f.Ext(); ok {
					covered[x.FieldID] = true
				} else if _, e, ok := f.Expression.SQL(); ok {
					if p, simple := SimpleColumn(e); simple {
						if col := t.ByPath(p); col != nil {
							covered[col.ID] = true
						}
					}
				}
			}
			for _, col := range t.Columns {
				if covered[col.ID] {
					continue
				}
				f := FieldFromColumn(col)
				base := f.Name
				for n := 2; names[lower(f.Name)]; n++ {
					f.Name = fmt.Sprintf("%s_%d", base, n)
				}
				names[lower(f.Name)] = true
				d.Fields = append(d.Fields, f)
			}
		case "key_changed":
			var pk []string
			for _, id := range t.IdentifierIDs {
				for _, f := range d.Fields {
					if x, ok := f.Ext(); ok && x.FieldID == id {
						pk = append(pk, f.Name)
					}
				}
			}
			d.PrimaryKey = pk
		}
		if t != nil {
			if x, ok := d.Ext(); ok {
				sid := t.SchemaID
				x.SchemaID = &sid
				d.SetExt(x)
			}
		}
	}
	for ds, fields := range dropFields {
		removeFields(c, ds, fields)
	}
	for _, ds := range dropDatasets {
		removeDataset(c, ds)
	}
	return c
}

func rewriteSQL(e Expression, expr string) Expression {
	out := Expression{}
	for _, d := range e.Dialects {
		if sqlDialects[d.Dialect] {
			d.Expression = expr
		}
		out.Dialects = append(out.Dialects, d)
	}
	return out
}

// link records the table's UUID and each simple field's column ID.
func link(d *Dataset, t *TableInfo) {
	sid := t.SchemaID
	d.SetExt(DatasetExt{TableUUID: t.UUID, Warehouse: t.Warehouse, Namespace: t.Namespace, Table: t.Name, SchemaID: &sid})
	for k := range d.Fields {
		f := &d.Fields[k]
		if _, ok := f.Ext(); ok {
			continue
		}
		if _, e, ok := f.Expression.SQL(); ok {
			if p, simple := SimpleColumn(e); simple {
				if col := t.ByPath(p); col != nil {
					f.SetExt(FieldExt{FieldID: col.ID, IcebergType: col.Type})
				}
			}
		}
	}
}

func removeFields(m *Model, ds string, fields []string) {
	d := m.Dataset(ds)
	if d == nil {
		return
	}
	gone := map[string]bool{}
	for _, f := range fields {
		gone[lower(f)] = true
	}
	d.Fields = slices.DeleteFunc(d.Fields, func(f Field) bool { return gone[lower(f.Name)] })
	keep := func(cols []string) bool {
		for _, c := range cols {
			if gone[lower(c)] {
				return false
			}
		}
		return true
	}
	if !keep(d.PrimaryKey) {
		d.PrimaryKey = nil
	}
	d.UniqueKeys = slices.DeleteFunc(d.UniqueKeys, func(uk []string) bool { return !keep(uk) })
	m.Relationships = slices.DeleteFunc(m.Relationships, func(r Relationship) bool {
		return (r.From == ds && !keep(r.FromColumns)) || (r.To == ds && !keep(r.ToColumns))
	})
}

func removeDataset(m *Model, ds string) {
	m.Datasets = slices.DeleteFunc(m.Datasets, func(d Dataset) bool { return d.Name == ds })
	m.Relationships = slices.DeleteFunc(m.Relationships, func(r Relationship) bool { return r.From == ds || r.To == ds })
	m.Metrics = slices.DeleteFunc(m.Metrics, func(mt Metric) bool {
		for _, d := range mt.Expression.Dialects {
			for _, r := range Refs(d.Expression) {
				if len(r.Parts) >= 2 && r.Parts[0] == ds {
					return true
				}
			}
		}
		return false
	})
}

// clone deep-copies a model through its canonical JSON form.
func clone(m *Model) *Model {
	b, _ := MarshalJSON(m)
	var c Model
	_ = jsonUnmarshal(b, &c)
	return &c
}
