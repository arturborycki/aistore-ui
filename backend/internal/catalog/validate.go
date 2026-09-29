package catalog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// ValidationError is reported to the client as HTTP 400.
type ValidationError struct{ Msg string }

func (e *ValidationError) Error() string { return e.Msg }

func invalid(format string, a ...any) error { return &ValidationError{Msg: fmt.Sprintf(format, a...)} }

var (
	warehouseRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$`)
	newTableNameRe = regexp.MustCompile(`^[a-z0-9_]{1,250}$`)
)

const (
	maxNamespaceLevels = 10
	maxNameLen         = 255
	maxPropertyBytes   = 2048
	maxTokenLen        = 4096
	maxSearchLen       = 255
	maxJSONDepth       = 64
)

// ValidWarehouse checks AIStor warehouse naming (3-63 chars, lowercase, digits, hyphens).
func ValidWarehouse(s string) error {
	if !warehouseRe.MatchString(s) {
		return invalid("invalid warehouse name")
	}
	return nil
}

// ValidName checks an existing namespace level, table or view name. Names
// created elsewhere may use a wider alphabet than AIStor's create-time rule,
// so reading allows any printable text except path separators.
func ValidName(kind, s string) error {
	if s == "" || len(s) > maxNameLen || !utf8.ValidString(s) {
		return invalid("invalid %s name", kind)
	}
	if s == "." || s == ".." {
		return invalid("invalid %s name", kind)
	}
	for _, r := range s {
		if r == '/' || r == '\\' || r == 0x1f || unicode.IsControl(r) {
			return invalid("invalid %s name: contains a forbidden character", kind)
		}
	}
	return nil
}

// ValidNewTableName applies AIStor's create-time table naming rule.
func ValidNewTableName(s string) error {
	if !newTableNameRe.MatchString(s) {
		return invalid("table name must be 1-250 characters of lowercase letters, digits and underscores")
	}
	return nil
}

// ParseNamespace decodes the BFF namespace path parameter: levels joined by
// the unit separator (0x1F), percent-encoded, as in the Iceberg REST spec.
func ParseNamespace(raw string) ([]string, error) {
	dec, err := url.PathUnescape(raw)
	if err != nil {
		return nil, invalid("invalid namespace encoding")
	}
	return ValidNamespaceLevels(strings.Split(dec, "\x1f"))
}

func ValidNamespaceLevels(levels []string) ([]string, error) {
	if len(levels) == 0 || len(levels) > maxNamespaceLevels {
		return nil, invalid("namespace must have 1-%d levels", maxNamespaceLevels)
	}
	for _, l := range levels {
		if err := ValidName("namespace", l); err != nil {
			return nil, err
		}
	}
	return levels, nil
}

// ---------------------------------------------------------------- query rules

// QueryRule validates one query parameter and maps it to its upstream name.
type QueryRule struct {
	Upstream string // upstream name; defaults to the BFF name
	Required bool
	Multi    bool // may repeat
	Check    func(v string) error
}

func qBool(v string) error {
	if v != "true" && v != "false" {
		return invalid("expected true or false")
	}
	return nil
}

func qIntRange(lo, hi int) func(string) error {
	return func(v string) error {
		n, err := strconv.Atoi(v)
		if err != nil || n < lo || n > hi {
			return invalid("expected an integer between %d and %d", lo, hi)
		}
		return nil
	}
}

func qEnum(vals ...string) func(string) error {
	return func(v string) error {
		for _, x := range vals {
			if v == x {
				return nil
			}
		}
		return invalid("expected one of %s", strings.Join(vals, ", "))
	}
}

func qText(max int) func(string) error {
	return func(v string) error {
		if len(v) > max || !utf8.ValidString(v) {
			return invalid("value too long or not UTF-8")
		}
		for _, r := range v {
			if unicode.IsControl(r) {
				return invalid("value contains control characters")
			}
		}
		return nil
	}
}

func qNamespace(v string) error {
	_, err := ValidNamespaceLevels(strings.Split(v, "\x1f"))
	return err
}

// listQuery returns the query rules shared by the list operations, with the
// sort values allowed for the entity being listed.
func listQuery(sorts ...string) map[string]QueryRule {
	return map[string]QueryRule{
		"pageToken":  {Check: qText(maxTokenLen)},
		"pageSize":   {Check: qIntRange(1, 1000)},
		"search":     {Check: qText(maxSearchLen)},
		"stats":      {Check: qBool},
		"page":       {Check: qIntRange(0, 1<<30)},
		"page_size":  {Check: qIntRange(1, 1000)},
		"sort":       {Check: qEnum(append([]string{"name"}, sorts...)...)},
		"sort_order": {Check: qEnum("asc", "desc")},
		"ui_token":   {Check: qText(maxTokenLen)},
	}
}

// ApplyQuery validates in against rules and returns the upstream query.
func ApplyQuery(rules map[string]QueryRule, in url.Values) (url.Values, error) {
	out := url.Values{}
	for k, vs := range in {
		rule, ok := rules[k]
		if !ok {
			return nil, invalid("unknown query parameter %q", k)
		}
		if len(vs) > 1 && !rule.Multi {
			return nil, invalid("query parameter %q may appear once", k)
		}
		if len(vs) > 100 {
			return nil, invalid("too many values for %q", k)
		}
		for _, v := range vs {
			if rule.Check != nil {
				if err := rule.Check(v); err != nil {
					return nil, invalid("query parameter %q: %s", k, err.Error())
				}
			}
			name := rule.Upstream
			if name == "" {
				name = k
			}
			out.Add(name, v)
		}
	}
	for k, rule := range rules {
		if rule.Required && in.Get(k) == "" {
			return nil, invalid("query parameter %q is required", k)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- body validation

// BodyValidator validates a decoded JSON request body and may return a
// normalised re-encoding of it.
type BodyValidator func(p *Params, raw []byte) ([]byte, error)

// decodeStrict decodes raw into v rejecting unknown fields and trailing data.
func decodeStrict(raw []byte, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return invalid("invalid request body: %s", cleanJSONErr(err))
	}
	if dec.More() {
		return invalid("invalid request body: trailing data")
	}
	return nil
}

func cleanJSONErr(err error) string {
	var se *json.SyntaxError
	if errors.As(err, &se) {
		return fmt.Sprintf("syntax error at offset %d", se.Offset)
	}
	var te *json.UnmarshalTypeError
	if errors.As(err, &te) {
		return fmt.Sprintf("field %q has the wrong type", te.Field)
	}
	return err.Error()
}

// checkJSONObject ensures raw is a single JSON object within the depth limit.
func checkJSONObject(raw []byte) (map[string]json.RawMessage, error) {
	if err := checkDepth(raw); err != nil {
		return nil, err
	}
	var m map[string]json.RawMessage
	dec := json.NewDecoder(bytes.NewReader(raw))
	if err := dec.Decode(&m); err != nil || m == nil {
		return nil, invalid("request body must be a JSON object")
	}
	if dec.More() {
		return nil, invalid("invalid request body: trailing data")
	}
	return m, nil
}

func checkDepth(raw []byte) error {
	depth := 0
	inStr, esc := false, false
	for _, c := range raw {
		switch {
		case esc:
			esc = false
		case inStr && c == '\\':
			esc = true
		case c == '"':
			inStr = !inStr
		case inStr:
		case c == '{' || c == '[':
			depth++
			if depth > maxJSONDepth {
				return invalid("request body is nested too deeply")
			}
		case c == '}' || c == ']':
			depth--
		}
	}
	return nil
}

// anyObject accepts any JSON object (used for AIStor extension bodies whose
// shape is owned by the server, e.g. encryption and maintenance settings).
func anyObject(_ *Params, raw []byte) ([]byte, error) {
	if _, err := checkJSONObject(raw); err != nil {
		return nil, err
	}
	return raw, nil
}

func checkProperties(props map[string]string, table bool) error {
	for k, v := range props {
		if k == "" || len(k) > maxPropertyBytes || len(v) > maxPropertyBytes {
			return invalid("property keys and values must be 1-%d bytes", maxPropertyBytes)
		}
		if table {
			if err := checkTablePropertyKey(k); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkTablePropertyKey(k string) error {
	if strings.HasPrefix(k, "write.data.path") {
		return invalid("property %q is managed by AIStor and cannot be set", k)
	}
	if strings.HasPrefix(k, "write.metadata.") && !allowedMetadataProps[k] {
		return invalid("property %q is not supported by AIStor", k)
	}
	return nil
}

// allowedMetadataProps are write.metadata.* properties that do not relocate metadata.
var allowedMetadataProps = map[string]bool{
	"write.metadata.compression-codec":                    true,
	"write.metadata.metrics.default":                      true,
	"write.metadata.previous-versions-max":                true,
	"write.metadata.delete-after-commit.enabled":          true,
	"write.metadata.metrics.max-inferred-column-defaults": true,
}

type identifier struct {
	Namespace []string `json:"namespace"`
	Name      string   `json:"name"`
}

func (id *identifier) validate(kind string) error {
	if _, err := ValidNamespaceLevels(id.Namespace); err != nil {
		return err
	}
	return ValidName(kind, id.Name)
}

// ---- warehouses

func vCreateWarehouse(_ *Params, raw []byte) ([]byte, error) {
	var b struct {
		Name            string `json:"name"`
		UpgradeExisting *bool  `json:"upgrade-existing,omitempty"`
	}
	if err := decodeStrict(raw, &b); err != nil {
		return nil, err
	}
	if err := ValidWarehouse(b.Name); err != nil {
		return nil, invalid("warehouse name must be 3-63 characters of lowercase letters, digits and hyphens")
	}
	return json.Marshal(b)
}

// ---- namespaces

func vCreateNamespace(_ *Params, raw []byte) ([]byte, error) {
	var b struct {
		Namespace  []string          `json:"namespace"`
		Properties map[string]string `json:"properties,omitempty"`
	}
	if err := decodeStrict(raw, &b); err != nil {
		return nil, err
	}
	if _, err := ValidNamespaceLevels(b.Namespace); err != nil {
		return nil, err
	}
	if err := checkProperties(b.Properties, false); err != nil {
		return nil, err
	}
	return json.Marshal(b)
}

func vNamespaceProperties(_ *Params, raw []byte) ([]byte, error) {
	var b struct {
		Updates  map[string]string `json:"updates,omitempty"`
		Removals []string          `json:"removals,omitempty"`
	}
	if err := decodeStrict(raw, &b); err != nil {
		return nil, err
	}
	if len(b.Updates) == 0 && len(b.Removals) == 0 {
		return nil, invalid("nothing to update")
	}
	if err := checkProperties(b.Updates, false); err != nil {
		return nil, err
	}
	for _, k := range b.Removals {
		if _, dup := b.Updates[k]; dup {
			return nil, invalid("property %q is both updated and removed", k)
		}
	}
	return json.Marshal(b)
}

// ---- tables

func vCreateTable(_ *Params, raw []byte) ([]byte, error) {
	m, err := checkJSONObject(raw)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{"name": true, "schema": true, "partition-spec": true, "write-order": true, "properties": true, "stage-create": true}
	for k := range m {
		if k == "location" {
			return nil, invalid("AIStor manages table locations; a custom location cannot be set")
		}
		if !allowed[k] {
			return nil, invalid("unknown field %q", k)
		}
	}
	var b struct {
		Name       string            `json:"name"`
		Schema     *schema           `json:"schema"`
		Properties map[string]string `json:"properties"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, invalid("invalid request body: %s", cleanJSONErr(err))
	}
	if err := ValidNewTableName(b.Name); err != nil {
		return nil, err
	}
	if b.Schema == nil {
		return nil, invalid("schema is required")
	}
	if err := b.Schema.validate(); err != nil {
		return nil, err
	}
	if err := checkProperties(b.Properties, true); err != nil {
		return nil, err
	}
	return raw, nil
}

// schema is decoded loosely, only to reject default values (unsupported by AIStor).
type schema struct {
	Type   string        `json:"type"`
	Fields []schemaField `json:"fields"`
}

type schemaField struct {
	ID           int             `json:"id"`
	Name         string          `json:"name"`
	Type         json.RawMessage `json:"type"`
	InitialDef   json.RawMessage `json:"initial-default,omitempty"`
	WriteDefault json.RawMessage `json:"write-default,omitempty"`
}

func (s *schema) validate() error {
	if s.Type != "struct" {
		return invalid("schema type must be struct")
	}
	if len(s.Fields) == 0 {
		return invalid("schema must have at least one field")
	}
	return checkFields(s.Fields)
}

func checkFields(fields []schemaField) error {
	for _, f := range fields {
		if f.Name == "" {
			return invalid("every schema field needs a name")
		}
		if len(f.InitialDef) > 0 && string(f.InitialDef) != "null" || len(f.WriteDefault) > 0 && string(f.WriteDefault) != "null" {
			return invalid("field %q: default column values are not supported by AIStor", f.Name)
		}
		// Recurse into nested struct types.
		var nested schema
		if len(f.Type) > 0 && f.Type[0] == '{' {
			if json.Unmarshal(f.Type, &nested) == nil && nested.Type == "struct" {
				if err := checkFields(nested.Fields); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

var tableRequirementTypes = setOf("assert-create", "assert-table-uuid", "assert-ref-snapshot-id",
	"assert-last-assigned-field-id", "assert-current-schema-id", "assert-last-assigned-partition-id",
	"assert-default-spec-id", "assert-default-sort-order-id")

var tableUpdateActions = setOf("upgrade-format-version", "add-schema", "set-current-schema", "add-spec",
	"set-default-spec", "add-sort-order", "set-default-sort-order", "add-snapshot", "set-snapshot-ref",
	"remove-snapshots", "remove-snapshot-ref", "set-properties", "remove-properties", "set-statistics",
	"remove-statistics", "set-partition-statistics", "remove-partition-statistics", "remove-partition-specs",
	"remove-schemas", "add-encryption-key", "remove-encryption-key", "append")

var viewRequirementTypes = setOf("assert-view-uuid")

var viewUpdateActions = setOf("upgrade-format-version", "add-schema", "set-properties", "remove-properties",
	"add-view-version", "set-current-view-version")

func setOf(v ...string) map[string]bool {
	m := make(map[string]bool, len(v))
	for _, s := range v {
		m[s] = true
	}
	return m
}

type commitBody struct {
	Identifier   *identifier       `json:"identifier,omitempty"`
	Requirements []json.RawMessage `json:"requirements"`
	Updates      []json.RawMessage `json:"updates"`
}

func validateCommit(c *commitBody, reqTypes, actions map[string]bool, table bool) error {
	if len(c.Updates) == 0 {
		return invalid("updates must not be empty")
	}
	if len(c.Updates) > 1000 || len(c.Requirements) > 100 {
		return invalid("too many updates or requirements")
	}
	for _, r := range c.Requirements {
		var t struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(r, &t) != nil || !reqTypes[t.Type] {
			return invalid("unsupported requirement type %q", t.Type)
		}
	}
	for _, u := range c.Updates {
		var a struct {
			Action   string            `json:"action"`
			Updates  map[string]string `json:"updates"`
			Location string            `json:"location"`
		}
		if json.Unmarshal(u, &a) != nil {
			return invalid("malformed update")
		}
		if a.Action == "set-location" || a.Action == "assign-uuid" {
			return invalid("update %q is not permitted: AIStor manages this value", a.Action)
		}
		if !actions[a.Action] {
			return invalid("unsupported update action %q", a.Action)
		}
		if a.Action == "set-properties" {
			if err := checkProperties(a.Updates, table); err != nil {
				return err
			}
		}
	}
	return nil
}

func commitValidator(reqTypes, actions map[string]bool, table bool, kind string) BodyValidator {
	return func(p *Params, raw []byte) ([]byte, error) {
		if err := checkDepth(raw); err != nil {
			return nil, err
		}
		var c commitBody
		if err := decodeStrict(raw, &c); err != nil {
			return nil, err
		}
		if c.Identifier != nil {
			if err := c.Identifier.validate(kind); err != nil {
				return nil, err
			}
			if !equalLevels(c.Identifier.Namespace, p.Namespace) || c.Identifier.Name != p.Name {
				return nil, invalid("identifier in body does not match the request path")
			}
		}
		if err := validateCommit(&c, reqTypes, actions, table); err != nil {
			return nil, err
		}
		return raw, nil
	}
}

func equalLevels(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

var (
	vCommitTable = commitValidator(tableRequirementTypes, tableUpdateActions, true, "table")
	vCommitView  = commitValidator(viewRequirementTypes, viewUpdateActions, false, "view")
)

func vTransaction(_ *Params, raw []byte) ([]byte, error) {
	if err := checkDepth(raw); err != nil {
		return nil, err
	}
	var b struct {
		TableChanges []commitBody `json:"table-changes"`
	}
	if err := decodeStrict(raw, &b); err != nil {
		return nil, err
	}
	if len(b.TableChanges) == 0 || len(b.TableChanges) > 100 {
		return nil, invalid("table-changes must contain 1-100 entries")
	}
	for i := range b.TableChanges {
		c := &b.TableChanges[i]
		if c.Identifier == nil {
			return nil, invalid("every table change needs an identifier")
		}
		if err := c.Identifier.validate("table"); err != nil {
			return nil, err
		}
		if err := validateCommit(c, tableRequirementTypes, tableUpdateActions, true); err != nil {
			return nil, err
		}
	}
	return raw, nil
}

func vRename(kind string) BodyValidator {
	return func(_ *Params, raw []byte) ([]byte, error) {
		var b struct {
			Source      identifier `json:"source"`
			Destination identifier `json:"destination"`
		}
		if err := decodeStrict(raw, &b); err != nil {
			return nil, err
		}
		if err := b.Source.validate(kind); err != nil {
			return nil, err
		}
		if err := b.Destination.validate(kind); err != nil {
			return nil, err
		}
		if kind == "table" {
			if err := ValidNewTableName(b.Destination.Name); err != nil {
				return nil, err
			}
		}
		return json.Marshal(b)
	}
}

func vRegister(kind string) BodyValidator {
	return func(_ *Params, raw []byte) ([]byte, error) {
		var b struct {
			Name             string `json:"name"`
			MetadataLocation string `json:"metadata-location"`
			Overwrite        *bool  `json:"overwrite,omitempty"`
		}
		if err := decodeStrict(raw, &b); err != nil {
			return nil, err
		}
		if err := ValidName(kind, b.Name); err != nil {
			return nil, err
		}
		if !strings.HasPrefix(b.MetadataLocation, "s3://") || len(b.MetadataLocation) > 2048 || !strings.HasSuffix(b.MetadataLocation, ".metadata.json") {
			return nil, invalid("metadata-location must be an s3:// URI of a *.metadata.json file")
		}
		if kind == "view" && b.Overwrite != nil {
			return nil, invalid("overwrite is not supported when registering a view")
		}
		return json.Marshal(b)
	}
}

func vCreateView(_ *Params, raw []byte) ([]byte, error) {
	m, err := checkJSONObject(raw)
	if err != nil {
		return nil, err
	}
	allowed := map[string]bool{"name": true, "schema": true, "view-version": true, "properties": true}
	for k := range m {
		if k == "location" {
			return nil, invalid("a custom view metadata location is not supported by AIStor")
		}
		if !allowed[k] {
			return nil, invalid("unknown field %q", k)
		}
	}
	var b struct {
		Name        string            `json:"name"`
		Schema      *schema           `json:"schema"`
		ViewVersion json.RawMessage   `json:"view-version"`
		Properties  map[string]string `json:"properties"`
	}
	if err := json.Unmarshal(raw, &b); err != nil {
		return nil, invalid("invalid request body: %s", cleanJSONErr(err))
	}
	if err := ValidNewTableName(b.Name); err != nil {
		return nil, invalid("view name must be 1-250 characters of lowercase letters, digits and underscores")
	}
	if b.Schema == nil || len(b.ViewVersion) == 0 {
		return nil, invalid("schema and view-version are required")
	}
	if err := b.Schema.validate(); err != nil {
		return nil, err
	}
	if err := checkProperties(b.Properties, false); err != nil {
		return nil, err
	}
	return raw, nil
}
