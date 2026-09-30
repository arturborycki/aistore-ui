package inspect

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"math/big"
	"strings"
	"testing"

	"github.com/hamba/avro/v2/ocf"
)

func le32(v int32) []byte {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, uint32(v))
	return b
}
func le64(v int64) []byte {
	b := make([]byte, 8)
	binary.LittleEndian.PutUint64(b, uint64(v))
	return b
}

func TestDecodeBounds(t *testing.T) {
	neg := new(big.Int).Sub(new(big.Int).Lsh(big.NewInt(1), 16), big.NewInt(12345)).Bytes() // -12345 in two's complement (2 bytes)
	cases := []struct {
		typ  string
		b    []byte
		want string
	}{
		{"int", le32(-7), "-7"},
		{"long", le64(6000000000), "6000000000"},
		{"long", le32(42), "42"}, // written before int→long promotion
		{"date", le32(8035), "1992-01-01"},
		{"timestamptz", le64(1_700_000_000_123_456), "2023-11-14 22:13:20.123456Z"},
		{"timestamp", le64(0), "1970-01-01 00:00:00.000000"},
		{"decimal(15, 2)", big.NewInt(81087).Bytes(), "810.87"},
		{"decimal(10, 3)", neg, "-12.345"},
		{"string", []byte("ALGERIA"), "ALGERIA"},
		{"boolean", []byte{1}, "true"},
		{"uuid", []byte{0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0, 1, 2, 3, 4, 5, 6, 7}, "12345678-9abc-def0-0001-020304050607"},
	}
	for _, c := range cases {
		v, ok := DecodeBound(c.typ, c.b)
		if !ok || v.String() != c.want {
			t.Errorf("%s %x: got %q (ok=%v), want %q", c.typ, c.b, v.String(), ok, c.want)
		}
	}
	a, _ := DecodeBound("decimal(10, 3)", neg)
	b, _ := DecodeBound("decimal(10, 3)", big.NewInt(1).Bytes())
	if !a.Less(b) {
		t.Fatal("negative decimal should order before positive")
	}
	if _, ok := DecodeBound("int", []byte{1, 2, 3}); ok {
		t.Fatal("malformed int accepted")
	}
}

func TestFormatPartition(t *testing.T) {
	cases := []struct {
		tr, src string
		v       any
		want    string
	}{
		{"day", "timestamptz", map[string]any{"int": 19000}, "2022-01-08"},
		{"month", "date", 264, "1992-01"},
		{"year", "timestamp", 56, "2026"},
		{"hour", "timestamptz", 1, "1970-01-01-01"},
		{"bucket[16]", "long", 7, "7"},
		{"identity", "string", "EU", "EU"},
		{"identity", "date", 8035, "1992-01-01"},
		{"void", "long", nil, "null"},
	}
	for _, c := range cases {
		if got := FormatPartition(c.tr, c.src, c.v); got != c.want {
			t.Errorf("%s(%s) %v: got %q want %q", c.tr, c.src, c.v, got, c.want)
		}
	}
}

func TestPathsMustStayInTheTable(t *testing.T) {
	loc := "s3://edw1/abc/tbl"
	for p, want := range map[string]bool{
		"s3://edw1/abc/tbl/metadata/m.avro":  true,
		"s3://edw1/abc/tbl2/metadata/m.avro": false,
		"s3://other/abc/tbl/metadata/m.avro": false,
		"s3://edw1/abc/tbl/../x/m.avro":      false,
		"https://edw1/abc/tbl/m.avro":        false,
	} {
		if got := under(loc, p); got != want {
			t.Errorf("under(%s) = %v", p, got)
		}
	}
	md := `{"metadata":{"location":"s3://wh/t","current-snapshot-id":1,"snapshots":[{"snapshot-id":1,"manifest-list":"s3://wh/elsewhere/list.avro"}]}}`
	_, err := Inspect(context.Background(), []byte(md), "", func(context.Context, string, string) ([]byte, error) {
		t.Fatal("fetched an object outside the table")
		return nil, nil
	}, DefaultLimits)
	if !errors.Is(err, ErrOutsideTable) {
		t.Fatalf("expected ErrOutsideTable, got %v", err)
	}
}

func TestTrailingBytesAreTolerated(t *testing.T) {
	var buf bytes.Buffer
	enc, _ := ocf.NewEncoder(`{"type":"record","name":"r","fields":[{"name":"a","type":"long"}]}`, &buf)
	_ = enc.Encode(map[string]any{"a": int64(7)})
	_ = enc.Close()
	raw := append(buf.Bytes(), 0x00) // a stray byte, as some writers produce
	rows, _, err := records(context.Background(), func(context.Context, string, string) ([]byte, error) { return raw, nil }, "s3://b/k", DefaultLimits)
	if err != nil || len(rows) != 1 || num(rows[0]["a"]) != 7 {
		t.Fatalf("rows=%v err=%v", rows, err)
	}
	if !strings.HasPrefix(string(raw), "Obj") {
		t.Fatal("not an avro file")
	}
}
