// Package inspect reads a table snapshot's manifests (Avro container files
// in object storage) and summarises them like Iceberg's metadata tables:
// manifests, data and delete files, partitions, and per-column statistics
// aggregated from the data files' column metrics.
//
// Every object read is restricted to paths under the table's own location,
// and is fetched with the caller's own credentials (the fetch function), so
// a user only sees what their policy lets them read.
package inspect

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/iskorotkov/avro/v2"
	"github.com/iskorotkov/avro/v2/ocf"
)

// avroAPI bounds what a (possibly hostile) manifest can make the decoder
// allocate: without these limits a declared block count is trusted as is.
var avroAPI = avro.Config{
	MaxByteSliceSize:  8 << 20,
	MaxSliceAllocSize: 1 << 20,
	MaxMapAllocSize:   1 << 20,
}.Freeze()

// Fetch reads an object given as bucket and key.
type Fetch func(ctx context.Context, bucket, key string) ([]byte, error)

// Limits bound the work for one inspection.
type Limits struct {
	MaxManifests   int // manifests read
	MaxEntries     int // manifest entries (files) scanned
	MaxFiles       int // files returned
	MaxPartitions  int // partitions returned
	MaxObjectBytes int // per manifest / manifest list
	Concurrency    int
}

var DefaultLimits = Limits{MaxManifests: 2000, MaxEntries: 2_000_000, MaxFiles: 1000, MaxPartitions: 2000, MaxObjectBytes: 128 << 20, Concurrency: 8}

// Result is the inspection of one snapshot.
type Result struct {
	SnapshotID     string      `json:"snapshotId"`
	ManifestList   string      `json:"manifestList"`
	Summary        Summary     `json:"summary"`
	Manifests      []Manifest  `json:"manifests"`
	Files          []File      `json:"files"`
	Partitions     []Partition `json:"partitions"`
	Columns        []Column    `json:"columns"`
	Truncated      bool        `json:"truncated"`
	FilesTruncated bool        `json:"filesTruncated"`
}

type Summary struct {
	Manifests         int   `json:"manifests"`
	DataManifests     int   `json:"dataManifests"`
	DeleteManifests   int   `json:"deleteManifests"`
	DataFiles         int   `json:"dataFiles"`
	PositionDeletes   int   `json:"positionDeleteFiles"`
	EqualityDeletes   int   `json:"equalityDeleteFiles"`
	Records           int64 `json:"records"`
	DeletedRecords    int64 `json:"deleteFileRecords"`
	DataSize          int64 `json:"dataSize"`
	DeleteSize        int64 `json:"deleteSize"`
	EntriesScanned    int   `json:"entriesScanned"`
	ManifestsScanned  int   `json:"manifestsScanned"`
	FilesWithoutStats int   `json:"filesWithoutStats"`
}

type Manifest struct {
	Path            string `json:"path"`
	Content         string `json:"content"` // data | deletes
	SpecID          int    `json:"specId"`
	Length          int64  `json:"length"`
	AddedSnapshotID string `json:"addedSnapshotId,omitempty"`
	AddedFiles      int64  `json:"addedFiles"`
	ExistingFiles   int64  `json:"existingFiles"`
	DeletedFiles    int64  `json:"deletedFiles"`
	AddedRows       int64  `json:"addedRows"`
	ExistingRows    int64  `json:"existingRows"`
	DeletedRows     int64  `json:"deletedRows"`
	SequenceNumber  int64  `json:"sequenceNumber"`
}

// PartitionValue is one partition field's value, in spec order.
type PartitionValue struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type File struct {
	Path      string           `json:"path"`
	Content   string           `json:"content"` // data | position-deletes | equality-deletes
	Format    string           `json:"format"`
	SpecID    int              `json:"specId"`
	Partition []PartitionValue `json:"partition,omitempty"`
	Records   int64            `json:"records"`
	Size      int64            `json:"size"`
	Status    string           `json:"status"` // added | existing
	Sequence  int64            `json:"sequenceNumber,omitempty"`
}

type Partition struct {
	SpecID      int              `json:"specId"`
	Values      []PartitionValue `json:"values"`
	Records     int64            `json:"records"`
	Files       int              `json:"files"`
	Size        int64            `json:"size"`
	DeleteFiles int              `json:"deleteFiles"`
}

type Column struct {
	ID            int    `json:"id"`
	Path          string `json:"path"`
	Type          string `json:"type"`
	ValueCount    *int64 `json:"valueCount,omitempty"`
	NullCount     *int64 `json:"nullCount,omitempty"`
	NaNCount      *int64 `json:"nanCount,omitempty"`
	Lower         string `json:"lower,omitempty"`
	Upper         string `json:"upper,omitempty"`
	Size          *int64 `json:"size,omitempty"`
	FilesWithStat int    `json:"filesWithStats"`
	// BoundsTruncated: writers truncate string/binary bounds (16 characters
	// by default), so lower/upper are prefixes rather than exact values.
	BoundsTruncated bool `json:"boundsTruncated,omitempty"`
}

// ---------------------------------------------------------------- metadata

type tableMeta struct {
	Location        string       `json:"location"`
	CurrentSnapshot json.Number  `json:"current-snapshot-id"`
	CurrentSchemaID int          `json:"current-schema-id"`
	Schemas         []schemaJSON `json:"schemas"`
	Specs           []struct {
		SpecID int `json:"spec-id"`
		Fields []struct {
			Name      string `json:"name"`
			Transform string `json:"transform"`
			SourceID  int    `json:"source-id"`
		} `json:"fields"`
	} `json:"partition-specs"`
	Snapshots []struct {
		ID           json.Number `json:"snapshot-id"`
		ManifestList string      `json:"manifest-list"`
		SchemaID     *int        `json:"schema-id"`
	} `json:"snapshots"`
}

type schemaJSON struct {
	SchemaID int         `json:"schema-id"`
	Fields   []fieldJSON `json:"fields"`
}

type fieldJSON struct {
	ID   int             `json:"id"`
	Name string          `json:"name"`
	Type json.RawMessage `json:"type"`
}

type colInfo struct {
	path string
	typ  string // primitive type, or "" for nested containers
}

// columns maps field id → path and primitive type (struct leaves, list
// elements and map keys/values included).
func columns(fields []fieldJSON, prefix string, out map[int]colInfo) {
	for _, f := range fields {
		p := f.Name
		if prefix != "" {
			p = prefix + "." + f.Name
		}
		addType(f.ID, p, f.Type, out)
	}
}

func addType(id int, path string, raw json.RawMessage, out map[int]colInfo) {
	var prim string
	if json.Unmarshal(raw, &prim) == nil {
		out[id] = colInfo{path: path, typ: prim}
		return
	}
	var t struct {
		Type      string          `json:"type"`
		Fields    []fieldJSON     `json:"fields"`
		ElementID int             `json:"element-id"`
		Element   json.RawMessage `json:"element"`
		KeyID     int             `json:"key-id"`
		Key       json.RawMessage `json:"key"`
		ValueID   int             `json:"value-id"`
		Value     json.RawMessage `json:"value"`
	}
	_ = json.Unmarshal(raw, &t)
	out[id] = colInfo{path: path}
	switch t.Type {
	case "struct":
		columns(t.Fields, path, out)
	case "list":
		addType(t.ElementID, path+".element", t.Element, out)
	case "map":
		addType(t.KeyID, path+".key", t.Key, out)
		addType(t.ValueID, path+".value", t.Value, out)
	}
}

// ErrNoSnapshot means the table (or the requested snapshot) has no data yet.
var ErrNoSnapshot = errors.New("the table has no snapshot")

// ErrOutsideTable means metadata points outside the table's location.
var ErrOutsideTable = errors.New("a manifest path is outside the table location")

// SplitS3 splits s3://bucket/key (also s3a/s3n).
func SplitS3(uri string) (bucket, key string, ok bool) {
	for _, p := range []string{"s3://", "s3a://", "s3n://"} {
		if rest, found := strings.CutPrefix(uri, p); found {
			b, k, ok := strings.Cut(rest, "/")
			return b, k, ok && b != "" && k != ""
		}
	}
	return "", "", false
}

// under reports whether path lies within the table location.
func under(location, path string) bool {
	lb, lk, ok1 := SplitS3(strings.TrimSuffix(location, "/") + "/x")
	pb, pk, ok2 := SplitS3(path)
	if !ok1 || !ok2 || lb != pb {
		return false
	}
	prefix := strings.TrimSuffix(lk, "x")
	return strings.HasPrefix(pk, prefix) && !strings.Contains(pk, "/../")
}

// ---------------------------------------------------------------- avro helpers

// unwrap resolves Avro union values, which the generic decoder returns as
// {"<branch type>": value}.
func unwrap(v any) any {
	m, ok := v.(map[string]any)
	if !ok || len(m) != 1 {
		return v
	}
	for k, x := range m {
		base := k
		if i := strings.IndexByte(k, '.'); i >= 0 {
			base = k[:i]
		}
		switch base {
		case "array", "map", "int", "long", "string", "bytes", "boolean", "float", "double", "fixed", "null":
			return x
		}
	}
	return v
}

func num(v any) int64 {
	switch x := unwrap(v).(type) {
	case int:
		return int64(x)
	case int32:
		return int64(x)
	case int64:
		return x
	case float64:
		return int64(x)
	}
	return 0
}

// kv decodes Iceberg's map<int, T> encoding: an array of {key, value} records.
func kv(v any) map[int]any {
	out := map[int]any{}
	switch x := unwrap(v).(type) {
	case []any:
		for _, e := range x {
			if r, ok := e.(map[string]any); ok {
				out[int(num(r["key"]))] = unwrap(r["value"])
			}
		}
	case map[string]any: // a real Avro map (string keys)
		for k, val := range x {
			var id int
			if _, err := fmt.Sscan(k, &id); err == nil {
				out[id] = unwrap(val)
			}
		}
	}
	return out
}

func records(ctx context.Context, fetch Fetch, uri string, lim Limits) ([]map[string]any, map[string][]byte, error) {
	b, k, ok := SplitS3(uri)
	if !ok {
		return nil, nil, fmt.Errorf("unsupported path %q", uri)
	}
	raw, err := fetch(ctx, b, k)
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > lim.MaxObjectBytes {
		return nil, nil, fmt.Errorf("%s is larger than %d bytes", uri, lim.MaxObjectBytes)
	}
	dec, err := ocf.NewDecoder(bytes.NewReader(trimTrailing(raw)), ocf.WithDecoderConfig(avroAPI))
	if err != nil {
		return nil, nil, fmt.Errorf("read %s: %w", uri, err)
	}
	var out []map[string]any
	for dec.HasNext() {
		var v any
		if err := dec.Decode(&v); err != nil {
			return nil, nil, fmt.Errorf("decode %s: %w", uri, err)
		}
		if m, ok := v.(map[string]any); ok {
			out = append(out, m)
		}
	}
	if err := dec.Error(); err != nil {
		return nil, nil, fmt.Errorf("decode %s: %w", uri, err)
	}
	return out, dec.Metadata(), nil
}

// ---------------------------------------------------------------- inspection

type colAgg struct {
	values, nulls, nans, size int64
	hasV, hasN, hasNaN, hasS  bool
	lower, upper              *Value
	files                     int
	truncated                 bool
}

// Inspect summarises snapshot (empty = current) of a table given its
// LoadTable response.
func Inspect(ctx context.Context, loadResult []byte, snapshot string, fetch Fetch, lim Limits) (*Result, error) {
	var lr struct {
		Metadata tableMeta `json:"metadata"`
	}
	dec := json.NewDecoder(bytes.NewReader(loadResult))
	dec.UseNumber()
	if err := dec.Decode(&lr); err != nil {
		return nil, fmt.Errorf("table metadata: %w", err)
	}
	md := lr.Metadata
	if snapshot == "" {
		snapshot = md.CurrentSnapshot.String()
	}
	if snapshot == "" || snapshot == "-1" {
		return nil, ErrNoSnapshot
	}
	var manifestList string
	schemaID := md.CurrentSchemaID
	for _, s := range md.Snapshots {
		if s.ID.String() == snapshot {
			manifestList = s.ManifestList
			if s.SchemaID != nil {
				schemaID = *s.SchemaID
			}
		}
	}
	if manifestList == "" {
		return nil, fmt.Errorf("%w %s", ErrNoSnapshot, snapshot)
	}
	if !under(md.Location, manifestList) {
		return nil, ErrOutsideTable
	}

	// Field id → path/type: the snapshot's schema first, then older/newer ones.
	cols := map[int]colInfo{}
	var order []int
	for _, s := range md.Schemas {
		if s.SchemaID == schemaID {
			columns(s.Fields, "", cols)
		}
	}
	for id := range cols {
		order = append(order, id)
	}
	for _, s := range md.Schemas {
		extra := map[int]colInfo{}
		columns(s.Fields, "", extra)
		for id, c := range extra {
			if _, ok := cols[id]; !ok {
				cols[id] = c
			}
		}
	}
	type specField struct{ name, transform, source string }
	specs := map[int][]specField{}
	for _, sp := range md.Specs {
		for _, f := range sp.Fields {
			specs[sp.SpecID] = append(specs[sp.SpecID], specField{f.Name, f.Transform, cols[f.SourceID].typ})
		}
	}

	res := &Result{SnapshotID: snapshot, ManifestList: manifestList, Manifests: []Manifest{}, Files: []File{}, Partitions: []Partition{}, Columns: []Column{}}
	mlist, _, err := records(ctx, fetch, manifestList, lim)
	if err != nil {
		return nil, err
	}
	for _, m := range mlist {
		content := "data"
		if num(m["content"]) == 1 {
			content = "deletes"
		}
		mf := Manifest{
			Path: fmt.Sprint(unwrap(m["manifest_path"])), Content: content, SpecID: int(num(m["partition_spec_id"])), Length: num(m["manifest_length"]),
			AddedFiles: num(m["added_files_count"]) + num(m["added_data_files_count"]), ExistingFiles: num(m["existing_files_count"]) + num(m["existing_data_files_count"]),
			DeletedFiles: num(m["deleted_files_count"]) + num(m["deleted_data_files_count"]), AddedRows: num(m["added_rows_count"]), ExistingRows: num(m["existing_rows_count"]),
			DeletedRows: num(m["deleted_rows_count"]), SequenceNumber: num(m["sequence_number"]),
		}
		if id := unwrap(m["added_snapshot_id"]); id != nil {
			mf.AddedSnapshotID = fmt.Sprint(id)
		}
		if !under(md.Location, mf.Path) {
			return nil, ErrOutsideTable
		}
		res.Manifests = append(res.Manifests, mf)
		if content == "data" {
			res.Summary.DataManifests++
		} else {
			res.Summary.DeleteManifests++
		}
	}
	res.Summary.Manifests = len(res.Manifests)

	toRead := res.Manifests
	if len(toRead) > lim.MaxManifests {
		toRead, res.Truncated = toRead[:lim.MaxManifests], true
	}

	var (
		mu       sync.Mutex
		firstErr error
		aggs     = map[int]*colAgg{}
		parts    = map[string]*Partition{}
		entries  int
		files    []File
	)
	sem := make(chan struct{}, max(1, lim.Concurrency))
	var wg sync.WaitGroup
	for _, mf := range toRead {
		wg.Add(1)
		go func(mf Manifest) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			if ctx.Err() != nil {
				return
			}
			rows, _, err := records(ctx, fetch, mf.Path, lim)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				if firstErr == nil {
					firstErr = err
				}
				return
			}
			res.Summary.ManifestsScanned++
			for _, e := range rows {
				if num(e["status"]) == 2 { // deleted in this snapshot
					continue
				}
				if entries >= lim.MaxEntries {
					res.Truncated = true
					return
				}
				entries++
				df, _ := unwrap(e["data_file"]).(map[string]any)
				if df == nil {
					continue
				}
				path := fmt.Sprint(unwrap(df["file_path"]))
				if !under(md.Location, path) {
					// Registered tables may reference data elsewhere; only record it.
					path = "(outside table location) " + path
				}
				f := File{Path: path, Format: strings.ToLower(fmt.Sprint(unwrap(df["file_format"]))), SpecID: mf.SpecID, Records: num(df["record_count"]), Size: num(df["file_size_in_bytes"])}
				switch num(df["content"]) {
				case 1:
					f.Content = "position-deletes"
				case 2:
					f.Content = "equality-deletes"
				default:
					f.Content = "data"
				}
				if num(e["status"]) == 1 {
					f.Status = "added"
				} else {
					f.Status = "existing"
				}
				f.Sequence = num(e["sequence_number"])
				if pv, ok := unwrap(df["partition"]).(map[string]any); ok && len(specs[mf.SpecID]) > 0 {
					for _, sf := range specs[mf.SpecID] {
						f.Partition = append(f.Partition, PartitionValue{sf.name, FormatPartition(sf.transform, sf.source, pv[sf.name])})
					}
				}
				key := fmt.Sprintf("%d|%s", mf.SpecID, partKey(f.Partition))
				p := parts[key]
				if p == nil {
					p = &Partition{SpecID: mf.SpecID, Values: f.Partition}
					if p.Values == nil {
						p.Values = []PartitionValue{}
					}
					parts[key] = p
				}
				if f.Content == "data" {
					p.Files++
					p.Records += f.Records
					p.Size += f.Size
					res.Summary.DataFiles++
					res.Summary.Records += f.Records
					res.Summary.DataSize += f.Size
					aggregate(aggs, cols, df, &res.Summary)
				} else {
					p.DeleteFiles++
					res.Summary.DeletedRecords += f.Records
					res.Summary.DeleteSize += f.Size
					if f.Content == "position-deletes" {
						res.Summary.PositionDeletes++
					} else {
						res.Summary.EqualityDeletes++
					}
				}
				files = append(files, f)
			}
		}(mf)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	if ctx.Err() != nil {
		res.Truncated = true
	}
	res.Summary.EntriesScanned = entries

	sort.Slice(files, func(i, j int) bool {
		if files[i].Content != files[j].Content {
			return files[i].Content < files[j].Content
		}
		return files[i].Path < files[j].Path
	})
	if len(files) > lim.MaxFiles {
		files, res.FilesTruncated = files[:lim.MaxFiles], true
	}
	res.Files = files

	for _, p := range parts {
		res.Partitions = append(res.Partitions, *p)
	}
	sort.Slice(res.Partitions, func(i, j int) bool {
		a, b := res.Partitions[i], res.Partitions[j]
		if a.SpecID != b.SpecID {
			return a.SpecID < b.SpecID
		}
		return partKey(a.Values) < partKey(b.Values)
	})
	if len(res.Partitions) > lim.MaxPartitions {
		res.Partitions = res.Partitions[:lim.MaxPartitions]
		res.Truncated = true
	}

	// Columns in schema order (struct leaves included), then any others with stats.
	seen := map[int]bool{}
	var ids []int
	var walk func(fs []fieldJSON)
	for _, s := range md.Schemas {
		if s.SchemaID == schemaID {
			walk = func(fs []fieldJSON) {
				for _, f := range fs {
					sub := map[int]colInfo{}
					addType(f.ID, f.Name, f.Type, sub)
					keys := make([]int, 0, len(sub))
					for id := range sub {
						keys = append(keys, id)
					}
					sort.Ints(keys)
					for _, id := range keys {
						if cols[id].typ != "" && !seen[id] {
							seen[id] = true
							ids = append(ids, id)
						}
					}
				}
			}
			walk(s.Fields)
		}
	}
	for id := range aggs {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		c := Column{ID: id, Path: cols[id].path, Type: cols[id].typ}
		if a := aggs[id]; a != nil {
			c.FilesWithStat = a.files
			if a.hasV {
				c.ValueCount = ptr(a.values)
			}
			if a.hasN {
				c.NullCount = ptr(a.nulls)
			}
			if a.hasNaN {
				c.NaNCount = ptr(a.nans)
			}
			if a.hasS {
				c.Size = ptr(a.size)
			}
			if a.lower != nil {
				c.Lower = a.lower.String()
			}
			if a.upper != nil {
				c.Upper = a.upper.String()
			}
			c.BoundsTruncated = a.truncated
		}
		res.Columns = append(res.Columns, c)
	}
	_ = order
	return res, nil
}

func ptr(v int64) *int64 { return &v }

func partKey(vs []PartitionValue) string {
	var b strings.Builder
	for _, v := range vs {
		b.WriteString(v.Name + "=" + v.Value + "/")
	}
	return b.String()
}

func aggregate(aggs map[int]*colAgg, cols map[int]colInfo, df map[string]any, sum *Summary) {
	values, nulls, nans, sizes := kv(df["value_counts"]), kv(df["null_value_counts"]), kv(df["nan_value_counts"]), kv(df["column_sizes"])
	lowers, uppers := kv(df["lower_bounds"]), kv(df["upper_bounds"])
	if len(values) == 0 && len(nulls) == 0 && len(lowers) == 0 {
		sum.FilesWithoutStats++
	}
	get := func(id int) *colAgg {
		a := aggs[id]
		if a == nil {
			a = &colAgg{}
			aggs[id] = a
		}
		return a
	}
	touched := map[int]bool{}
	for id, v := range values {
		a := get(id)
		a.values += num(v)
		a.hasV = true
		touched[id] = true
	}
	for id, v := range nulls {
		a := get(id)
		a.nulls += num(v)
		a.hasN = true
		touched[id] = true
	}
	for id, v := range nans {
		a := get(id)
		a.nans += num(v)
		a.hasNaN = true
	}
	for id, v := range sizes {
		a := get(id)
		a.size += num(v)
		a.hasS = true
	}
	for id, v := range lowers {
		b, ok := v.([]byte)
		if !ok {
			continue
		}
		if val, ok := DecodeBound(cols[id].typ, b); ok {
			a := get(id)
			if a.lower == nil || val.Less(*a.lower) {
				a.lower = &val
			}
			if (val.kind == kString || val.kind == kBytes) && len(b) >= 16 {
				a.truncated = true
			}
		}
	}
	for id, v := range uppers {
		b, ok := v.([]byte)
		if !ok {
			continue
		}
		if val, ok := DecodeBound(cols[id].typ, b); ok {
			a := get(id)
			if a.upper == nil || a.upper.Less(val) {
				a.upper = &val
			}
			if (val.kind == kString || val.kind == kBytes) && len(b) >= 16 {
				a.truncated = true
			}
		}
	}
	for id := range touched {
		aggs[id].files++
	}
}

// trimTrailing drops bytes after the last block's sync marker. Some writers
// append stray bytes to manifest files, which strict decoders then try to
// read as another block ("invalid block").
func trimTrailing(raw []byte) []byte {
	sync, ok := syncMarker(raw)
	if !ok {
		return raw
	}
	if i := bytes.LastIndex(raw, sync); i >= 0 && i+16 < len(raw) {
		return raw[:i+16]
	}
	return raw
}

// syncMarker parses an Avro container header (magic, metadata map) and
// returns the 16-byte sync marker that follows it.
func syncMarker(b []byte) ([]byte, bool) {
	if len(b) < 4 || string(b[:4]) != "Obj\x01" {
		return nil, false
	}
	pos := 4
	long := func() (int64, bool) {
		var n uint64
		var shift uint
		for {
			if pos >= len(b) || shift > 63 {
				return 0, false
			}
			c := b[pos]
			pos++
			n |= uint64(c&0x7f) << shift
			if c&0x80 == 0 {
				break
			}
			shift += 7
		}
		return int64(n>>1) ^ -int64(n&1), true
	}
	skipBytes := func() bool {
		l, ok := long()
		if !ok || l < 0 || pos+int(l) > len(b) {
			return false
		}
		pos += int(l)
		return true
	}
	for {
		n, ok := long()
		if !ok {
			return nil, false
		}
		if n == 0 {
			break
		}
		if n < 0 {
			if _, ok := long(); !ok {
				return nil, false
			}
			n = -n
		}
		for i := int64(0); i < n; i++ {
			if !skipBytes() || !skipBytes() {
				return nil, false
			}
		}
	}
	if pos+16 > len(b) {
		return nil, false
	}
	return b[pos : pos+16], true
}
