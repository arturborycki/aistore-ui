package semantic

import (
	"bytes"
	"encoding/json"

	"gopkg.in/yaml.v3"
)

// SchemaURL is the $schema hint written into YAML documents for editors.
const SchemaURL = "https://raw.githubusercontent.com/apache/ossie/main/core-spec/ossie-schema.json"

const yamlHeader = "# yaml-language-server: $schema=" + SchemaURL + "\n" +
	"# Apache Ossie semantic model (spec " + SpecVersion + "), managed with the AIStor Catalog UI.\n"

// MarshalYAML renders the canonical YAML form: fixed key order, two-space
// indentation, sorted keys inside ai_context. The same model always yields
// the same bytes, so diffs and ETags are meaningful.
func MarshalYAML(m *Model) ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteString(yamlHeader)
	enc := yaml.NewEncoder(&buf)
	enc.SetIndent(2)
	if err := enc.Encode(normalize(m)); err != nil {
		return nil, err
	}
	if err := enc.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// MarshalJSON renders the canonical JSON form.
func MarshalJSON(m *Model) ([]byte, error) {
	b, err := json.MarshalIndent(normalize(m), "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// normalize returns a copy with empty optional collections dropped, so that
// "absent" and "empty" serialize identically.
func normalize(m *Model) *Model {
	c := *m
	if c.Version == "" {
		c.Version = SpecVersion
	}
	c.AIContext = normAI(c.AIContext)
	c.Datasets = append([]Dataset(nil), m.Datasets...)
	for i := range c.Datasets {
		d := &c.Datasets[i]
		d.AIContext = normAI(d.AIContext)
		if len(d.PrimaryKey) == 0 {
			d.PrimaryKey = nil
		}
		if len(d.UniqueKeys) == 0 {
			d.UniqueKeys = nil
		}
		d.Fields = append([]Field(nil), d.Fields...)
		for j := range d.Fields {
			f := &d.Fields[j]
			f.AIContext = normAI(f.AIContext)
			if f.Dimension != nil && f.Dimension.IsTime == nil {
				f.Dimension = nil
			}
		}
	}
	for i := range c.Relationships {
		c.Relationships[i].AIContext = normAI(c.Relationships[i].AIContext)
	}
	for i := range c.Metrics {
		c.Metrics[i].AIContext = normAI(c.Metrics[i].AIContext)
	}
	return &c
}

// normAI drops empty ai_context values (empty string, empty object, empty lists).
func normAI(v any) any {
	switch t := v.(type) {
	case string:
		if t == "" {
			return nil
		}
		return t
	case map[string]any:
		out := map[string]any{}
		for k, x := range t {
			switch y := x.(type) {
			case nil:
				continue
			case string:
				if y == "" {
					continue
				}
			case []any:
				if len(y) == 0 {
					continue
				}
			}
			out[k] = x
		}
		if len(out) == 0 {
			return nil
		}
		return out
	}
	return v
}

func jsonUnmarshal(b []byte, v any) error { return json.Unmarshal(b, v) }
