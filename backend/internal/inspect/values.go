package inspect

import (
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Value is a decoded Iceberg single value that can be ordered and displayed.
type Value struct {
	kind  kind
	i     int64
	f     float64
	s     string // string, and raw bytes for binary/fixed/uuid
	d     *big.Int
	scale int
	b     bool
	typ   string
}

type kind int

const (
	kInt kind = iota
	kFloat
	kString
	kBytes
	kDecimal
	kBool
)

var decimalRe = regexp.MustCompile(`^decimal\((\d+),\s*(\d+)\)$`)

// DecodeBound decodes Iceberg's single-value binary serialization (used for
// lower/upper bounds) for a primitive type. ok is false for unsupported
// types or malformed input.
func DecodeBound(typ string, b []byte) (Value, bool) {
	v := Value{typ: typ}
	switch {
	case typ == "boolean":
		if len(b) != 1 {
			return v, false
		}
		v.kind, v.b = kBool, b[0] != 0
	case typ == "int" || typ == "date":
		if len(b) != 4 {
			// A long lower bound after int→long promotion is still 4 bytes; tolerate 8.
			if len(b) == 8 {
				v.kind, v.i = kInt, int64(binary.LittleEndian.Uint64(b))
				return v, true
			}
			return v, false
		}
		v.kind, v.i = kInt, int64(int32(binary.LittleEndian.Uint32(b)))
	case typ == "long" || typ == "time" || strings.HasPrefix(typ, "timestamp"):
		switch len(b) {
		case 8:
			v.kind, v.i = kInt, int64(binary.LittleEndian.Uint64(b))
		case 4: // written as int before promotion to long
			v.kind, v.i = kInt, int64(int32(binary.LittleEndian.Uint32(b)))
		default:
			return v, false
		}
	case typ == "float":
		if len(b) != 4 {
			return v, false
		}
		v.kind, v.f = kFloat, float64(math.Float32frombits(binary.LittleEndian.Uint32(b)))
	case typ == "double":
		switch len(b) {
		case 8:
			v.kind, v.f = kFloat, math.Float64frombits(binary.LittleEndian.Uint64(b))
		case 4: // float promoted to double
			v.kind, v.f = kFloat, float64(math.Float32frombits(binary.LittleEndian.Uint32(b)))
		default:
			return v, false
		}
	case typ == "string":
		v.kind, v.s = kString, string(b)
	case typ == "uuid" || typ == "binary" || strings.HasPrefix(typ, "fixed"):
		v.kind, v.s = kBytes, string(b)
	case decimalRe.MatchString(typ):
		m := decimalRe.FindStringSubmatch(typ)
		v.scale, _ = strconv.Atoi(m[2])
		v.kind, v.d = kDecimal, twosComplement(b)
	default:
		return v, false
	}
	return v, true
}

func twosComplement(b []byte) *big.Int {
	n := new(big.Int).SetBytes(b)
	if len(b) > 0 && b[0]&0x80 != 0 {
		n.Sub(n, new(big.Int).Lsh(big.NewInt(1), uint(len(b)*8)))
	}
	return n
}

// Less orders two values of the same type.
func (v Value) Less(o Value) bool {
	switch v.kind {
	case kInt:
		return v.i < o.i
	case kFloat:
		return v.f < o.f
	case kString, kBytes:
		return v.s < o.s
	case kDecimal:
		return v.d.Cmp(o.d) < 0
	case kBool:
		return !v.b && o.b
	}
	return false
}

// String renders the value for people (dates, timestamps and decimals in
// their natural form, bytes in hex).
func (v Value) String() string {
	switch v.kind {
	case kBool:
		return strconv.FormatBool(v.b)
	case kFloat:
		return strconv.FormatFloat(v.f, 'g', -1, 64)
	case kString:
		return v.s
	case kBytes:
		if v.typ == "uuid" && len(v.s) == 16 {
			h := hex.EncodeToString([]byte(v.s))
			return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
		}
		h := hex.EncodeToString([]byte(v.s))
		if len(h) > 64 {
			h = h[:64] + "…"
		}
		return "0x" + h
	case kDecimal:
		return formatDecimal(v.d, v.scale)
	}
	return formatInt(v.typ, v.i)
}

func formatDecimal(n *big.Int, scale int) string {
	s := new(big.Int).Abs(n).String()
	neg := n.Sign() < 0
	if scale > 0 {
		for len(s) <= scale {
			s = "0" + s
		}
		s = s[:len(s)-scale] + "." + s[len(s)-scale:]
	}
	if neg {
		s = "-" + s
	}
	return s
}

// formatInt renders int-encoded temporal types; other ints as numbers.
func formatInt(typ string, i int64) string {
	switch typ {
	case "date":
		return time.Unix(0, 0).UTC().AddDate(0, 0, int(i)).Format("2006-01-02")
	case "time":
		d := time.Duration(i) * time.Microsecond
		return time.Unix(0, 0).UTC().Add(d).Format("15:04:05.000000")
	case "timestamp":
		return time.UnixMicro(i).UTC().Format("2006-01-02 15:04:05.000000")
	case "timestamptz":
		return time.UnixMicro(i).UTC().Format("2006-01-02 15:04:05.000000Z")
	case "timestamp_ns":
		return time.Unix(0, i).UTC().Format("2006-01-02 15:04:05.000000000")
	case "timestamptz_ns":
		return time.Unix(0, i).UTC().Format("2006-01-02 15:04:05.000000000Z")
	}
	return strconv.FormatInt(i, 10)
}

// FormatPartition renders a partition value produced by a transform.
func FormatPartition(transform, sourceType string, v any) string {
	if v == nil {
		return "null"
	}
	v = unwrap(v)
	if t, ok := v.(time.Time); ok {
		switch {
		case transform == "day" || sourceType == "date":
			return t.UTC().Format("2006-01-02")
		default:
			return t.UTC().Format(time.RFC3339Nano)
		}
	}
	n, isNum := toInt64(v)
	switch {
	case transform == "year" && isNum:
		return strconv.FormatInt(1970+n, 10)
	case transform == "month" && isNum:
		return fmt.Sprintf("%04d-%02d", 1970+n/12, n%12+1)
	case transform == "day" && isNum:
		return time.Unix(0, 0).UTC().AddDate(0, 0, int(n)).Format("2006-01-02")
	case transform == "hour" && isNum:
		return time.Unix(n*3600, 0).UTC().Format("2006-01-02-15")
	case transform == "identity" && isNum:
		return formatInt(sourceType, n)
	}
	switch x := v.(type) {
	case []byte:
		if sourceType == "uuid" && len(x) == 16 {
			return Value{kind: kBytes, s: string(x), typ: "uuid"}.String()
		}
		if d := decimalRe.FindStringSubmatch(sourceType); d != nil && strings.HasPrefix(transform, "identity") {
			sc, _ := strconv.Atoi(d[2])
			return formatDecimal(twosComplement(x), sc)
		}
		return Value{kind: kBytes, s: string(x)}.String()
	case float32:
		return strconv.FormatFloat(float64(x), 'g', -1, 32)
	case float64:
		return strconv.FormatFloat(x, 'g', -1, 64)
	case *big.Rat:
		return x.FloatString(6)
	}
	if isNum {
		return strconv.FormatInt(n, 10)
	}
	return fmt.Sprint(v)
}

func toInt64(v any) (int64, bool) {
	switch x := v.(type) {
	case int:
		return int64(x), true
	case int32:
		return int64(x), true
	case int64:
		return x, true
	case time.Duration:
		return int64(x / time.Microsecond), true
	}
	return 0, false
}
