package semantic

import (
	"fmt"
	"strings"
)

// Structural checks every model must pass beyond the JSON Schema: unique
// names, relationships and metrics that point at existing datasets and
// fields, and consistent key definitions.
func Validate(m *Model) []Problem {
	var ps []Problem
	dsNames := map[string]int{}
	for i, d := range m.Datasets {
		p := fmt.Sprintf("datasets[%d]", i)
		if j, dup := dsNames[lower(d.Name)]; dup {
			ps = append(ps, errorAt(p+".name", "dataset name %q is already used by datasets[%d]", d.Name, j))
		} else {
			dsNames[lower(d.Name)] = i
		}
		fieldNames := map[string]int{}
		for k, f := range d.Fields {
			fp := fmt.Sprintf("%s.fields[%d]", p, k)
			if j, dup := fieldNames[lower(f.Name)]; dup {
				ps = append(ps, errorAt(fp+".name", "field name %q is already used by fields[%d] of %s", f.Name, j, d.Name))
			} else {
				fieldNames[lower(f.Name)] = k
			}
		}
		keyCheck := func(path string, cols []string) {
			seen := map[string]bool{}
			for _, c := range cols {
				if seen[lower(c)] {
					ps = append(ps, errorAt(path, "column %q is listed twice", c))
				}
				seen[lower(c)] = true
				if len(d.Fields) > 0 && d.Field(c) == nil {
					ps = append(ps, warningAt(path, "%q is not a field of %s", c, d.Name))
				}
			}
		}
		keyCheck(p+".primary_key", d.PrimaryKey)
		for k, uk := range d.UniqueKeys {
			if len(uk) == 0 {
				ps = append(ps, errorAt(fmt.Sprintf("%s.unique_keys[%d]", p, k), "a unique key needs at least one column"))
			}
			keyCheck(fmt.Sprintf("%s.unique_keys[%d]", p, k), uk)
		}
	}
	relNames := map[string]int{}
	for i, r := range m.Relationships {
		p := fmt.Sprintf("relationships[%d]", i)
		if j, dup := relNames[lower(r.Name)]; dup {
			ps = append(ps, errorAt(p+".name", "relationship name %q is already used by relationships[%d]", r.Name, j))
		} else {
			relNames[lower(r.Name)] = i
		}
		from, to := m.Dataset(r.From), m.Dataset(r.To)
		if from == nil {
			ps = append(ps, errorAt(p+".from", "no dataset named %q", r.From))
		}
		if to == nil {
			ps = append(ps, errorAt(p+".to", "no dataset named %q", r.To))
		}
		if len(r.FromColumns) != len(r.ToColumns) {
			ps = append(ps, errorAt(p, "from_columns and to_columns must have the same number of columns (%d vs %d)", len(r.FromColumns), len(r.ToColumns)))
		}
		for k, c := range r.FromColumns {
			if from != nil && len(from.Fields) > 0 && from.Field(c) == nil {
				ps = append(ps, errorAt(fmt.Sprintf("%s.from_columns[%d]", p, k), "%q is not a field of %s", c, r.From))
			}
		}
		for k, c := range r.ToColumns {
			if to != nil && len(to.Fields) > 0 && to.Field(c) == nil {
				ps = append(ps, errorAt(fmt.Sprintf("%s.to_columns[%d]", p, k), "%q is not a field of %s", c, r.To))
			}
		}
		if to != nil && len(r.ToColumns) > 0 && !isKey(to, r.ToColumns) {
			ps = append(ps, warningAt(p+".to_columns", "%s is not the primary key or a unique key of %s; the join may duplicate rows", strings.Join(r.ToColumns, ", "), r.To))
		}
		if from != nil && to != nil {
			for k := range r.FromColumns {
				if k >= len(r.ToColumns) {
					break
				}
				a, b := from.Field(r.FromColumns[k]), to.Field(r.ToColumns[k])
				if a != nil && b != nil && a.Datatype != "" && b.Datatype != "" && a.Datatype != b.Datatype {
					ps = append(ps, warningAt(fmt.Sprintf("%s.from_columns[%d]", p, k), "%s.%s is %s but %s.%s is %s", r.From, a.Name, a.Datatype, r.To, b.Name, b.Datatype))
				}
			}
		}
	}
	metricNames := map[string]int{}
	for i, mt := range m.Metrics {
		p := fmt.Sprintf("metrics[%d]", i)
		if j, dup := metricNames[lower(mt.Name)]; dup {
			ps = append(ps, errorAt(p+".name", "metric name %q is already used by metrics[%d]", mt.Name, j))
		} else {
			metricNames[lower(mt.Name)] = i
		}
		ps = append(ps, checkExpression(m, nil, p+".expression", mt.Expression)...)
	}
	for i := range m.Datasets {
		d := &m.Datasets[i]
		for k, f := range d.Fields {
			ps = append(ps, checkExpression(m, d, fmt.Sprintf("datasets[%d].fields[%d].expression", i, k), f.Expression)...)
		}
	}
	return ps
}

func isKey(d *Dataset, cols []string) bool {
	same := func(a []string) bool {
		if len(a) != len(cols) {
			return false
		}
		set := map[string]bool{}
		for _, c := range a {
			set[lower(c)] = true
		}
		for _, c := range cols {
			if !set[lower(c)] {
				return false
			}
		}
		return true
	}
	if same(d.PrimaryKey) {
		return true
	}
	for _, uk := range d.UniqueKeys {
		if same(uk) {
			return true
		}
	}
	return false
}

// checkExpression verifies dataset.field references in SQL-like dialects.
// In metrics (scope nil) references must be qualified with a dataset name.
// In a field expression (scope set) references are the source table's
// columns and are checked against the catalog instead (CatalogProblems).
func checkExpression(m *Model, scope *Dataset, path string, e Expression) []Problem {
	var ps []Problem
	seenDialect := map[string]bool{}
	for k, d := range e.Dialects {
		dp := fmt.Sprintf("%s.dialects[%d]", path, k)
		if seenDialect[d.Dialect] {
			ps = append(ps, errorAt(dp+".dialect", "dialect %s is defined twice", d.Dialect))
		}
		seenDialect[d.Dialect] = true
		if strings.TrimSpace(d.Expression) == "" {
			ps = append(ps, errorAt(dp+".expression", "the expression is empty"))
			continue
		}
		if !sqlDialects[d.Dialect] || scope != nil {
			continue
		}
		if msg := balance(d.Expression); msg != "" {
			ps = append(ps, errorAt(dp+".expression", "%s", msg))
		}
		for _, r := range Refs(d.Expression) {
			if r.Call {
				continue
			}
			if len(r.Parts) == 1 {
				if IsKeyword(r.Parts[0]) {
					continue
				}
				for _, ds := range m.Datasets {
					if ds.Field(r.Parts[0]) != nil {
						ps = append(ps, warningAt(dp+".expression", "%s is not qualified; write %s.%s", r.Parts[0], ds.Name, r.Parts[0]))
						break
					}
				}
				continue
			}
			ds := m.Dataset(r.Parts[0])
			if ds == nil {
				ps = append(ps, errorAt(dp+".expression", "unknown dataset %q in %s", r.Parts[0], strings.Join(r.Parts, ".")))
				continue
			}
			if len(ds.Fields) > 0 && ds.Field(r.Parts[1]) == nil {
				ps = append(ps, errorAt(dp+".expression", "%s has no field %q", ds.Name, r.Parts[1]))
			}
		}
	}
	return ps
}

// balance reports unbalanced parentheses or an unterminated string.
func balance(expr string) string {
	depth := 0
	for i := 0; i < len(expr); i++ {
		switch expr[i] {
		case '\'':
			closed := false
			j := i + 1
			for j < len(expr) {
				if expr[j] == '\'' {
					if j+1 < len(expr) && expr[j+1] == '\'' {
						j += 2
						continue
					}
					closed = true
					break
				}
				j++
			}
			if !closed {
				return "unterminated string literal"
			}
			i = j
		case '(':
			depth++
		case ')':
			depth--
			if depth < 0 {
				return "unbalanced parentheses: unexpected )"
			}
		}
	}
	if depth > 0 {
		return "unbalanced parentheses: missing )"
	}
	return ""
}

// ParseSource splits a dataset source (catalog.ns….table, identifiers may be
// quoted) into its parts; ok is false for queries and other forms.
func ParseSource(source string) ([]string, bool) {
	refs := Refs(strings.TrimSpace(source))
	if len(refs) != 1 || refs[0].Call || refs[0].Start != 0 || refs[0].End != len(strings.TrimSpace(source)) || len(refs[0].Parts) < 3 {
		return nil, false
	}
	return refs[0].Parts, true
}

// CatalogProblems checks datasets against the Iceberg tables they resolve to
// (tables[i] is the table of m.Datasets[i], or nil if it did not resolve;
// unresolved[i] explains why). These are warnings: the model stays usable,
// and the drift view offers fixes.
func CatalogProblems(m *Model, tables []*TableInfo, unresolved []string) []Problem {
	var ps []Problem
	for i := range m.Datasets {
		d := &m.Datasets[i]
		p := fmt.Sprintf("datasets[%d]", i)
		t := tables[i]
		if t == nil {
			if unresolved[i] != "" {
				ps = append(ps, warningAt(p+".source", "%s", unresolved[i]))
			}
			continue
		}
		for k := range d.Fields {
			f := &d.Fields[k]
			_, expr, ok := f.Expression.SQL()
			if !ok {
				continue
			}
			fp := fmt.Sprintf("%s.fields[%d]", p, k)
			if col, simple := SimpleColumn(expr); simple {
				c := t.ByPath(col)
				if c == nil {
					ps = append(ps, warningAt(fp+".expression", "column %s does not exist in %s", col, t.Label()))
					continue
				}
				if f.Datatype != "" && !c.Nested && OssieType(c.Type) != f.Datatype && !(f.Datatype == "Opaque") {
					ps = append(ps, warningAt(fp+".datatype", "%s is %s in Iceberg, which maps to %s", col, c.Type, OssieType(c.Type)))
				}
				continue
			}
			for _, r := range Refs(expr) {
				if r.Call || (len(r.Parts) == 1 && IsKeyword(r.Parts[0])) {
					continue
				}
				if t.ByPath(strings.Join(r.Parts, ".")) == nil && t.ByPath(r.Parts[0]) == nil {
					ps = append(ps, warningAt(fp+".expression", "%s is not a column of %s", strings.Join(r.Parts, "."), t.Label()))
				}
			}
		}
	}
	return ps
}
