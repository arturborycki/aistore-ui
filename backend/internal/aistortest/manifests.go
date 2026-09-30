package aistortest

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"math/big"
	"math/rand"
	"strconv"
	"strings"
	"time"

	"github.com/iskorotkov/avro/v2/ocf"
)

// Iceberg v2 manifest list and manifest entry schemas (with field ids, as
// written by the Java and Python implementations).
const manifestListSchema = `{"type":"record","name":"manifest_file","fields":[
 {"name":"manifest_path","type":"string","field-id":500},
 {"name":"manifest_length","type":"long","field-id":501},
 {"name":"partition_spec_id","type":"int","field-id":502},
 {"name":"content","type":"int","field-id":517},
 {"name":"sequence_number","type":"long","field-id":515},
 {"name":"min_sequence_number","type":"long","field-id":516},
 {"name":"added_snapshot_id","type":"long","field-id":503},
 {"name":"added_files_count","type":"int","field-id":504},
 {"name":"existing_files_count","type":"int","field-id":505},
 {"name":"deleted_files_count","type":"int","field-id":506},
 {"name":"added_rows_count","type":"long","field-id":512},
 {"name":"existing_rows_count","type":"long","field-id":513},
 {"name":"deleted_rows_count","type":"long","field-id":514}]}`

func manifestEntrySchema(partFields []specField) string {
	var pf []string
	for _, f := range partFields {
		pf = append(pf, fmt.Sprintf(`{"name":%q,"type":["null","int"],"default":null,"field-id":%d}`, f.Name, f.FieldID))
	}
	kv := func(name string, id int, val string) string {
		return fmt.Sprintf(`{"name":%q,"type":["null",{"type":"array","logicalType":"map","items":{"type":"record","name":"k%d_v%d","fields":[{"name":"key","type":"int","field-id":%d},{"name":"value","type":%q,"field-id":%d}]}}],"default":null,"field-id":%d}`,
			name, id, id+1, id, val, id+1, id-2)
	}
	return `{"type":"record","name":"manifest_entry","fields":[
 {"name":"status","type":"int","field-id":0},
 {"name":"snapshot_id","type":["null","long"],"default":null,"field-id":1},
 {"name":"sequence_number","type":["null","long"],"default":null,"field-id":3},
 {"name":"file_sequence_number","type":["null","long"],"default":null,"field-id":4},
 {"name":"data_file","field-id":2,"type":{"type":"record","name":"r2","fields":[
  {"name":"content","type":"int","field-id":134},
  {"name":"file_path","type":"string","field-id":100},
  {"name":"file_format","type":"string","field-id":101},
  {"name":"partition","field-id":102,"type":{"type":"record","name":"r102","fields":[` + strings.Join(pf, ",") + `]}},
  {"name":"record_count","type":"long","field-id":103},
  {"name":"file_size_in_bytes","type":"long","field-id":104},
  ` + kv("column_sizes", 117, "long") + `,
  ` + kv("value_counts", 119, "long") + `,
  ` + kv("null_value_counts", 121, "long") + `,
  ` + kv("nan_value_counts", 138, "long") + `,
  ` + kv("lower_bounds", 126, "bytes") + `,
  ` + kv("upper_bounds", 129, "bytes") + `]}}]}`
}

type specField struct {
	Name      string `json:"name"`
	Transform string `json:"transform"`
	SourceID  int    `json:"source-id"`
	FieldID   int    `json:"field-id"`
}

type mdView struct {
	Location string `json:"location"`
	Schemas  []struct {
		SchemaID int               `json:"schema-id"`
		Fields   []json.RawMessage `json:"fields"`
	} `json:"schemas"`
	DefaultSpec int `json:"default-spec-id"`
	Specs       []struct {
		SpecID int         `json:"spec-id"`
		Fields []specField `json:"fields"`
	} `json:"partition-specs"`
	Snapshots []struct {
		ID           json.Number       `json:"snapshot-id"`
		Sequence     int64             `json:"sequence-number"`
		Timestamp    int64             `json:"timestamp-ms"`
		ManifestList string            `json:"manifest-list"`
		SchemaID     int               `json:"schema-id"`
		Summary      map[string]string `json:"summary"`
	} `json:"snapshots"`
}

type leaf struct {
	id       int
	typ      string
	required bool
}

func leaves(raw []json.RawMessage, out *[]leaf) {
	for _, r := range raw {
		var f struct {
			ID       int             `json:"id"`
			Required bool            `json:"required"`
			Type     json.RawMessage `json:"type"`
		}
		_ = json.Unmarshal(r, &f)
		var prim string
		if json.Unmarshal(f.Type, &prim) == nil {
			*out = append(*out, leaf{f.ID, prim, f.Required})
			continue
		}
		var st struct {
			Type   string            `json:"type"`
			Fields []json.RawMessage `json:"fields"`
		}
		_ = json.Unmarshal(f.Type, &st)
		if st.Type == "struct" {
			leaves(st.Fields, out)
		}
	}
}

// bound serialises a synthetic value for field type t (Iceberg single-value encoding).
func bound(t string, x int64, ts time.Time) []byte {
	le := func(n int, v uint64) []byte {
		b := make([]byte, 8)
		binary.LittleEndian.PutUint64(b, v)
		return b[:n]
	}
	switch {
	case t == "int":
		return le(4, uint64(uint32(int32(x))))
	case t == "long":
		return le(8, uint64(x))
	case t == "date":
		return le(4, uint64(uint32(int32(ts.Unix()/86400))))
	case strings.HasPrefix(t, "timestamp"):
		return le(8, uint64(ts.UnixMicro()))
	case t == "string":
		return []byte(fmt.Sprintf("value-%06d", x))
	case t == "uuid":
		b := make([]byte, 16)
		binary.BigEndian.PutUint64(b[8:], uint64(x))
		return b
	case t == "boolean":
		return []byte{byte(x % 2)}
	case strings.HasPrefix(t, "decimal"):
		return big.NewInt(x * 137).Bytes()
	case t == "double":
		return le(8, uint64(x)) // arbitrary but well-formed
	}
	return nil
}

// WriteManifests writes Avro manifest lists and manifests for every seeded
// table's snapshots into objs (one bucket per warehouse), so that file,
// partition and column-statistics views work against the test server.
func (c *Catalog) WriteManifests(objs *ObjectStore) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	for whName, wh := range c.warehouses {
		objs.CreateBucket(whName, true)
		for _, ns := range wh.namespaces {
			for _, t := range ns.tbl {
				if err := writeTableManifests(objs, whName, t); err != nil {
					return fmt.Errorf("%s: %w", t.name, err)
				}
			}
		}
	}
	return nil
}

func writeTableManifests(objs *ObjectStore, wh string, t *tableState) error {
	raw, _ := json.Marshal(t.metadata)
	var md mdView
	if err := json.Unmarshal(raw, &md); err != nil {
		return err
	}
	var spec []specField
	for _, s := range md.Specs {
		if s.SpecID == md.DefaultSpec {
			spec = s.Fields
		}
	}
	r := rand.New(rand.NewSource(int64(len(t.name)) * 7919))
	key := func(uri string) string { return strings.TrimPrefix(uri, "s3://"+wh+"/") }
	type written struct {
		path              string
		length            int64
		snapshot          string
		seq, files, added int64
	}
	var manifests []written
	for si, s := range md.Snapshots {
		var cols []leaf
		for _, sc := range md.Schemas {
			if sc.SchemaID == s.SchemaID {
				leaves(sc.Fields, &cols)
			}
		}
		addedRecords, _ := strconv.ParseInt(s.Summary["added-records"], 10, 64)
		nFiles := int64(0)
		if addedRecords > 0 {
			nFiles = min(int64(1+r.Intn(6)), 8)
		}
		var buf bytes.Buffer
		enc, err := ocf.NewEncoder(manifestEntrySchema(spec), &buf, ocf.WithMetadata(map[string][]byte{"format-version": []byte("2"), "content": []byte("data")}))
		if err != nil {
			return err
		}
		ts := time.UnixMilli(s.Timestamp).UTC()
		for f := int64(0); f < nFiles; f++ {
			recs := addedRecords / nFiles
			part := map[string]any{}
			for _, pf := range spec {
				switch {
				case pf.Transform == "day":
					part[pf.Name] = int(ts.Unix()/86400) - int(f%2)
				case strings.HasPrefix(pf.Transform, "bucket"):
					part[pf.Name] = int((f + int64(si)) % 16)
				default:
					part[pf.Name] = int(f)
				}
			}
			sizes, values, nulls, lows, ups := []any{}, []any{}, []any{}, []any{}, []any{}
			base := int64(si)*1_000_000 + f*10_000
			for _, c := range cols {
				nullCount := int64(0)
				if !c.required {
					nullCount = recs / int64(20+c.id)
				}
				sizes = append(sizes, map[string]any{"key": c.id, "value": recs * 4})
				values = append(values, map[string]any{"key": c.id, "value": recs})
				nulls = append(nulls, map[string]any{"key": c.id, "value": nullCount})
				if lo := bound(c.typ, base, ts.Add(-time.Duration(f+1)*time.Hour)); lo != nil {
					lows = append(lows, map[string]any{"key": c.id, "value": lo})
					ups = append(ups, map[string]any{"key": c.id, "value": bound(c.typ, base+9_999, ts.Add(-time.Duration(f)*time.Hour))})
				}
			}
			entry := map[string]any{
				"status": 1, "snapshot_id": map[string]any{"long": mustInt(s.ID)}, "sequence_number": map[string]any{"long": s.Sequence}, "file_sequence_number": map[string]any{"long": s.Sequence},
				"data_file": map[string]any{
					"content": 0, "file_path": fmt.Sprintf("%s/data/snap-%d/%05d.parquet", md.Location, si, f), "file_format": "PARQUET",
					"partition": nullableInts(part), "record_count": recs, "file_size_in_bytes": recs*int64(len(cols))*3 + 4096,
					"column_sizes": map[string]any{"array": sizes}, "value_counts": map[string]any{"array": values}, "null_value_counts": map[string]any{"array": nulls},
					"nan_value_counts": nil, "lower_bounds": map[string]any{"array": lows}, "upper_bounds": map[string]any{"array": ups},
				},
			}
			if err := enc.Encode(entry); err != nil {
				return err
			}
		}
		if err := enc.Close(); err != nil {
			return err
		}
		mpath := fmt.Sprintf("%s/metadata/%s-m%d.avro", md.Location, s.ID.String(), si)
		objs.Put(wh, key(mpath), buf.Bytes())
		manifests = append(manifests, written{mpath, int64(buf.Len()), s.ID.String(), s.Sequence, nFiles, addedRecords})

		// Manifest list: every manifest written so far (a simplification of
		// Iceberg's rewrite rules that keeps each snapshot self-consistent).
		var lb bytes.Buffer
		le, err := ocf.NewEncoder(manifestListSchema, &lb, ocf.WithMetadata(map[string][]byte{"snapshot-id": []byte(s.ID.String()), "format-version": []byte("2")}))
		if err != nil {
			return err
		}
		for _, m := range manifests {
			sid, _ := strconv.ParseInt(m.snapshot, 10, 64)
			if err := le.Encode(map[string]any{
				"manifest_path": m.path, "manifest_length": m.length, "partition_spec_id": md.DefaultSpec, "content": 0,
				"sequence_number": m.seq, "min_sequence_number": m.seq, "added_snapshot_id": sid,
				"added_files_count": int(m.files), "existing_files_count": 0, "deleted_files_count": 0,
				"added_rows_count": m.added, "existing_rows_count": int64(0), "deleted_rows_count": int64(0),
			}); err != nil {
				return err
			}
		}
		if err := le.Close(); err != nil {
			return err
		}
		objs.Put(wh, key(s.ManifestList), lb.Bytes())
	}
	return nil
}

func nullableInts(m map[string]any) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = map[string]any{"int": v}
	}
	return out
}

func mustInt(n json.Number) int64 {
	v, _ := n.Int64()
	return v
}
