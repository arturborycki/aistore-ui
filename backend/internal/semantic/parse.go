package semantic

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/text/language"
	"golang.org/x/text/message"
	"gopkg.in/yaml.v3"
)

//go:embed spec/ossie-schema.json
var schemaJSON []byte

// SchemaJSON returns the embedded official Ossie JSON Schema.
func SchemaJSON() []byte { return schemaJSON }

// Problem is a validation finding. Errors block saving; warnings do not.
type Problem struct {
	Severity string `json:"severity"` // error | warning
	Path     string `json:"path"`     // e.g. datasets[0].fields[2].expression
	Message  string `json:"message"`
}

func errorAt(path, format string, a ...any) Problem {
	return Problem{Severity: "error", Path: path, Message: fmt.Sprintf(format, a...)}
}

func warningAt(path, format string, a ...any) Problem {
	return Problem{Severity: "warning", Path: path, Message: fmt.Sprintf(format, a...)}
}

// HasErrors reports whether any problem is an error.
func HasErrors(ps []Problem) bool {
	for _, p := range ps {
		if p.Severity == "error" {
			return true
		}
	}
	return false
}

// Limits bound what a document may contain.
type Limits struct {
	MaxBytes    int
	MaxDepth    int
	MaxNodes    int
	MaxDatasets int
	MaxFields   int // per dataset
	MaxMetrics  int
}

var DefaultLimits = Limits{MaxBytes: 1 << 20, MaxDepth: 64, MaxNodes: 200_000, MaxDatasets: 500, MaxFields: 2000, MaxMetrics: 2000}

// ErrInvalid wraps documents that cannot be parsed at all.
var ErrInvalid = errors.New("invalid semantic model")

var (
	compileOnce sync.Once
	compiled    *jsonschema.Schema
	compileErr  error
)

func schema() (*jsonschema.Schema, error) {
	compileOnce.Do(func() {
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(schemaJSON))
		if err != nil {
			compileErr = err
			return
		}
		c := jsonschema.NewCompiler()
		const url = "https://github.com/apache/ossie/core-spec/ossie-schema.json"
		if err := c.AddResource(url, doc); err != nil {
			compileErr = err
			return
		}
		compiled, compileErr = c.Compile(url)
	})
	return compiled, compileErr
}

// Parse decodes a YAML or JSON document (YAML is a superset of JSON), checks
// it against the official schema and returns the typed model. Problems are
// schema violations; err is returned when the bytes are not a document at all.
func Parse(data []byte, lim Limits) (*Model, []Problem, error) {
	if len(data) > lim.MaxBytes {
		return nil, nil, fmt.Errorf("%w: document is larger than %d bytes", ErrInvalid, lim.MaxBytes)
	}
	generic, err := decodeGeneric(data, lim)
	if err != nil {
		return nil, nil, err
	}
	if _, ok := generic.(map[string]any); !ok {
		return nil, nil, fmt.Errorf("%w: the document must be a mapping (an Ossie model)", ErrInvalid)
	}
	if ps := schemaProblems(generic); len(ps) > 0 {
		return nil, ps, nil
	}
	raw, err := json.Marshal(generic)
	if err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var m Model
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&m); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrInvalid, err)
	}
	var ps []Problem
	if len(m.Datasets) > lim.MaxDatasets {
		ps = append(ps, errorAt("datasets", "at most %d datasets are allowed", lim.MaxDatasets))
	}
	for i, d := range m.Datasets {
		if len(d.Fields) > lim.MaxFields {
			ps = append(ps, errorAt(fmt.Sprintf("datasets[%d].fields", i), "at most %d fields per dataset are allowed", lim.MaxFields))
		}
	}
	if len(m.Metrics) > lim.MaxMetrics {
		ps = append(ps, errorAt("metrics", "at most %d metrics are allowed", lim.MaxMetrics))
	}
	return &m, ps, nil
}

// decodeGeneric parses YAML into plain maps/slices/scalars, refusing anchors,
// aliases, multiple documents and non-string keys, within the size limits.
func decodeGeneric(data []byte, lim Limits) (any, error) {
	dec := yaml.NewDecoder(bytes.NewReader(data))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil, fmt.Errorf("%w: the document is empty", ErrInvalid)
		}
		return nil, fmt.Errorf("%w: %s", ErrInvalid, strings.TrimPrefix(err.Error(), "yaml: "))
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); err == nil {
		return nil, fmt.Errorf("%w: only one YAML document is allowed", ErrInvalid)
	}
	nodes := 0
	var conv func(n *yaml.Node, depth int) (any, error)
	conv = func(n *yaml.Node, depth int) (any, error) {
		nodes++
		if nodes > lim.MaxNodes {
			return nil, fmt.Errorf("%w: the document is too large", ErrInvalid)
		}
		if depth > lim.MaxDepth {
			return nil, fmt.Errorf("%w: the document is nested too deeply", ErrInvalid)
		}
		if n.Anchor != "" || n.Kind == yaml.AliasNode {
			return nil, fmt.Errorf("%w: YAML anchors and aliases are not allowed (line %d)", ErrInvalid, n.Line)
		}
		switch n.Kind {
		case yaml.DocumentNode:
			if len(n.Content) == 0 {
				return nil, fmt.Errorf("%w: the document is empty", ErrInvalid)
			}
			return conv(n.Content[0], depth)
		case yaml.MappingNode:
			out := make(map[string]any, len(n.Content)/2)
			for i := 0; i+1 < len(n.Content); i += 2 {
				k := n.Content[i]
				if k.Kind != yaml.ScalarNode || (k.Tag != "!!str" && k.Tag != "") {
					if k.Kind == yaml.ScalarNode && k.Tag == "!!merge" {
						return nil, fmt.Errorf("%w: YAML merge keys are not allowed (line %d)", ErrInvalid, k.Line)
					}
					if k.Kind != yaml.ScalarNode {
						return nil, fmt.Errorf("%w: mapping keys must be strings (line %d)", ErrInvalid, k.Line)
					}
				}
				if _, dup := out[k.Value]; dup {
					return nil, fmt.Errorf("%w: duplicate key %q (line %d)", ErrInvalid, k.Value, k.Line)
				}
				v, err := conv(n.Content[i+1], depth+1)
				if err != nil {
					return nil, err
				}
				out[k.Value] = v
			}
			return out, nil
		case yaml.SequenceNode:
			out := make([]any, 0, len(n.Content))
			for _, c := range n.Content {
				v, err := conv(c, depth+1)
				if err != nil {
					return nil, err
				}
				out = append(out, v)
			}
			return out, nil
		case yaml.ScalarNode:
			switch n.ShortTag() {
			case "!!null":
				return nil, nil
			case "!!bool":
				var b bool
				if err := n.Decode(&b); err != nil {
					return nil, fmt.Errorf("%w: %v", ErrInvalid, err)
				}
				return b, nil
			case "!!int", "!!float":
				return json.Number(normalizeNumber(n.Value)), nil
			default:
				// Strings, and timestamps/binary kept as their source text.
				return n.Value, nil
			}
		}
		return nil, fmt.Errorf("%w: unsupported YAML node (line %d)", ErrInvalid, n.Line)
	}
	return conv(&doc, 0)
}

func normalizeNumber(s string) string {
	if _, err := strconv.ParseFloat(s, 64); err == nil && !strings.ContainsAny(s, "_xXoObB") {
		return s
	}
	if i, err := strconv.ParseInt(strings.ReplaceAll(s, "_", ""), 0, 64); err == nil {
		return strconv.FormatInt(i, 10)
	}
	return "0"
}

var printer = message.NewPrinter(language.English)

func schemaProblems(doc any) []Problem {
	sch, err := schema()
	if err != nil {
		return []Problem{errorAt("", "the Ossie schema could not be loaded: %v", err)}
	}
	err = sch.Validate(doc)
	if err == nil {
		return nil
	}
	var ve *jsonschema.ValidationError
	if !errors.As(err, &ve) {
		return []Problem{errorAt("", "%v", err)}
	}
	var out []Problem
	seen := map[string]bool{}
	var walk func(e *jsonschema.ValidationError)
	walk = func(e *jsonschema.ValidationError) {
		if len(e.Causes) == 0 {
			p := errorAt(jsonPath(e.InstanceLocation), "%s", e.ErrorKind.LocalizedString(printer))
			if !seen[p.Path+p.Message] {
				seen[p.Path+p.Message] = true
				out = append(out, p)
			}
			return
		}
		for _, c := range e.Causes {
			walk(c)
		}
	}
	walk(ve)
	return out
}

// jsonPath renders an instance location as datasets[0].fields[2].name.
func jsonPath(loc []string) string {
	var b strings.Builder
	for _, s := range loc {
		if _, err := strconv.Atoi(s); err == nil {
			b.WriteString("[" + s + "]")
			continue
		}
		if b.Len() > 0 {
			b.WriteByte('.')
		}
		b.WriteString(s)
	}
	return b.String()
}
