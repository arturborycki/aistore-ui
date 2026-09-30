package semantic

import (
	"strings"
	"unicode"
)

// Ref is an identifier chain in a SQL expression, e.g. orders.amount.
type Ref struct {
	Parts []string
	Start int // byte offsets of the whole chain in the expression
	End   int
	// PartStarts/PartEnds locate each part (without quotes).
	PartStarts []int
	PartEnds   []int
	Quoted     []bool
	Call       bool // followed by "(" (a function call)
}

// Refs extracts identifier chains from a SQL-like expression, skipping
// string literals, comments and numbers. It is a tokenizer, not a parser:
// good enough to find which dataset.field an expression uses.
func Refs(expr string) []Ref {
	var out []Ref
	i := 0
	n := len(expr)
	for i < n {
		c := expr[i]
		switch {
		case c == '\'':
			i = skipQuoted(expr, i, '\'')
		case c == '-' && i+1 < n && expr[i+1] == '-':
			for i < n && expr[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && expr[i+1] == '*':
			j := strings.Index(expr[i+2:], "*/")
			if j < 0 {
				i = n
			} else {
				i += j + 4
			}
		case c >= '0' && c <= '9':
			for i < n && (isIdentChar(expr[i]) || expr[i] == '.') {
				i++
			}
		case isIdentStart(c) || c == '"' || c == '`':
			ref := Ref{Start: i}
			for {
				ps, pe, next, quoted, ok := identAt(expr, i)
				if !ok {
					break
				}
				ref.Parts = append(ref.Parts, expr[ps:pe])
				ref.PartStarts = append(ref.PartStarts, ps)
				ref.PartEnds = append(ref.PartEnds, pe)
				ref.Quoted = append(ref.Quoted, quoted)
				ref.End = next
				i = next
				if i < n && expr[i] == '.' && i+1 < n && (isIdentStart(expr[i+1]) || expr[i+1] == '"' || expr[i+1] == '`') {
					i++
					continue
				}
				break
			}
			if len(ref.Parts) == 0 {
				i++
				continue
			}
			j := i
			for j < n && (expr[j] == ' ' || expr[j] == '\t' || expr[j] == '\n' || expr[j] == '\r') {
				j++
			}
			ref.Call = j < n && expr[j] == '('
			out = append(out, ref)
		default:
			i++
		}
	}
	return out
}

func identAt(s string, i int) (start, end, next int, quoted, ok bool) {
	if i >= len(s) {
		return 0, 0, 0, false, false
	}
	if q := s[i]; q == '"' || q == '`' {
		j := i + 1
		for j < len(s) && s[j] != q {
			j++
		}
		if j >= len(s) {
			return 0, 0, 0, false, false
		}
		return i + 1, j, j + 1, true, true
	}
	if !isIdentStart(s[i]) {
		return 0, 0, 0, false, false
	}
	j := i
	for j < len(s) && isIdentChar(s[j]) {
		j++
	}
	return i, j, j, false, true
}

func skipQuoted(s string, i int, q byte) int {
	i++
	for i < len(s) {
		if s[i] == q {
			if i+1 < len(s) && s[i+1] == q {
				i += 2
				continue
			}
			return i + 1
		}
		i++
	}
	return i
}

func isIdentStart(c byte) bool { return c == '_' || unicode.IsLetter(rune(c)) }
func isIdentChar(c byte) bool {
	return c == '_' || c == '$' || unicode.IsLetter(rune(c)) || unicode.IsDigit(rune(c))
}

// sqlWords are keywords, literals and type names that are not column references.
var sqlWords = func() map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(`and or not null is in as case when then else end distinct all any some exists
		between like ilike true false over partition by order asc desc nulls first last rows range unbounded preceding
		following current row filter where within group interval cast try_cast extract from for date time timestamp
		timestamp_ltz timestamp_ntz timestamp_tz year quarter month week day hour minute second decimal numeric int integer bigint
		smallint tinyint float double real boolean varchar char string text binary with zone at local escape collate
		similar to limit offset union intersect except select having join on using`) {
		m[w] = true
	}
	return m
}()

// IsKeyword reports whether an unqualified identifier is a SQL keyword or type name.
func IsKeyword(s string) bool { return sqlWords[strings.ToLower(s)] }

// ReplaceRefs rewrites identifier chains. f returns the replacement for a
// chain's parts (nil to keep it). Quoting of unchanged parts is preserved;
// replaced parts are quoted only when needed.
func ReplaceRefs(expr string, f func(r Ref) []string) string {
	refs := Refs(expr)
	var b strings.Builder
	last := 0
	for _, r := range refs {
		repl := f(r)
		if repl == nil {
			continue
		}
		b.WriteString(expr[last:r.Start])
		for i, p := range repl {
			if i > 0 {
				b.WriteByte('.')
			}
			b.WriteString(quoteIdent(p))
		}
		last = r.End
	}
	b.WriteString(expr[last:])
	return b.String()
}

func quoteIdent(s string) string {
	ok := s != "" && isIdentStart(s[0]) && !IsKeyword(s)
	for i := 0; ok && i < len(s); i++ {
		ok = isIdentChar(s[i])
	}
	if ok {
		return s
	}
	return `"` + strings.ReplaceAll(s, `"`, `""`) + `"`
}

// SimpleColumn reports whether expr is just a (possibly dotted) column path,
// e.g. "amount" or "shipping.city", and returns the path.
func SimpleColumn(expr string) (string, bool) {
	e := strings.TrimSpace(expr)
	refs := Refs(e)
	if len(refs) != 1 || refs[0].Call || refs[0].Start != 0 || refs[0].End != len(e) {
		return "", false
	}
	if len(refs[0].Parts) == 1 && IsKeyword(refs[0].Parts[0]) {
		return "", false
	}
	return strings.Join(refs[0].Parts, "."), true
}
