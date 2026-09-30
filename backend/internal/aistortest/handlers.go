package aistortest

import (
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (c *Catalog) handleTables(w http.ResponseWriter, r *http.Request, wh *whState, ns *nsState, rest []string, q url.Values) {
	if ns.tbl == nil {
		ns.tbl = map[string]*tableState{}
	}
	if len(rest) == 0 {
		switch r.Method {
		case "GET":
			names := make([]string, 0, len(ns.tbl))
			for n := range ns.tbl {
				names = append(names, n)
			}
			lr := parseList(q)
			st := func(n string) stats { t := ns.tbl[n]; return stats{Records: t.records, Size: t.size} }
			page, next := lr.apply(w, names, st)
			ids := make([]any, 0, len(page))
			m := map[string]stats{}
			for _, n := range page {
				ids = append(ids, map[string]any{"namespace": ns.levels, "name": n})
				m[n] = st(n)
			}
			resp := map[string]any{"identifiers": ids}
			if next != "" {
				resp["next-page-token"] = next
			}
			if lr.stats {
				resp["stats"] = m
			}
			writeJSON(w, 200, resp)
		case "POST":
			body, err := readGeneric(r)
			if err != nil {
				writeCommitErr(w, err)
				return
			}
			name, _ := body["name"].(string)
			if _, ok := ns.tbl[name]; ok {
				iceErr(w, 409, "AlreadyExistsException", "table already exists: "+name)
				return
			}
			t, err := createTable(wh.name, ns.levels, body)
			if err != nil {
				writeCommitErr(w, err)
				return
			}
			ns.tbl[name] = t
			ns.recompute()
			writeJSON(w, 200, map[string]any{"metadata": t.metadata, "metadata-location": t.metaLoc, "config": map[string]any{}})
		}
		return
	}
	t, ok := ns.tbl[rest[0]]
	if !ok {
		iceErr(w, 404, "NoSuchTableException", "table does not exist: "+strings.Join(append(append([]string{}, ns.levels...), rest[0]), "."))
		return
	}
	sub := strings.Join(rest[1:], "/")
	arn := fmt.Sprintf("arn:aws:s3tables:::bucket/%s/table/%s", wh.name, t.uuid)
	switch {
	case sub == "" && r.Method == "GET":
		md := t.metadata
		if q.Get("snapshots") == "refs" {
			md = withRefSnapshotsOnly(md)
		}
		// Real catalogs may include storage configuration; the BFF must strip it.
		writeJSON(w, 200, map[string]any{"metadata": md, "metadata-location": t.metaLoc,
			"config": map[string]any{"s3.access-key-id": "SHOULD-NOT-LEAK", "s3.secret-access-key": "SHOULD-NOT-LEAK", "s3.delete-enabled": "false"}})
	case sub == "" && r.Method == "POST":
		body, err := readGeneric(r)
		if err == nil {
			var md map[string]any
			if md, err = commitTo(t, arr(body["requirements"]), arr(body["updates"])); err == nil {
				t.install(md)
				writeJSON(w, 200, map[string]any{"metadata": t.metadata, "metadata-location": t.metaLoc})
				return
			}
		}
		writeCommitErr(w, err)
	case sub == "" && r.Method == "DELETE":
		delete(ns.tbl, rest[0])
		ns.recompute()
		w.WriteHeader(204)
	case sub == "preview":
		limit, _ := strconv.Atoi(q.Get("limit"))
		if limit <= 0 {
			limit = 100
		}
		writeJSON(w, 200, previewRows(t, min(limit, 1000)))
	case sub == "maintenance-job-status":
		writeJSON(w, 200, map[string]any{"tableARN": arn, "status": t.maint})
	case sub == "maintenance" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"tableARN": arn, "configuration": t.maintCfg})
	case strings.HasPrefix(sub, "maintenance/"):
		typ := strings.TrimPrefix(sub, "maintenance/")
		if r.Method == "DELETE" {
			delete(t.maintCfg, typ)
			w.WriteHeader(204)
			return
		}
		body, err := readGeneric(r)
		if err == nil {
			var v map[string]any
			if v, err = maintenanceValue(body); err == nil {
				t.maintCfg[typ] = v
				if v["status"] == "disabled" {
					t.maint[typ] = map[string]any{"status": "Disabled"}
				} else if st, _ := t.maint[typ]["status"].(string); st == "Disabled" || st == "" {
					t.maint[typ] = map[string]any{"status": "Not_Yet_Run"}
				}
				w.WriteHeader(204)
				return
			}
		}
		writeCommitErr(w, err)
	case sub == "encryption" && r.Method == "GET":
		cfg := map[string]any{"sseAlgorithm": t.sse}
		if t.kmsKey != "" {
			cfg["kmsKeyArn"] = t.kmsKey
		}
		writeJSON(w, 200, map[string]any{"encryptionConfiguration": cfg})
	case sub == "encryption" && r.Method == "PUT":
		body, err := readGeneric(r)
		if err == nil {
			var v map[string]any
			if v, err = encryptionValue(body); err == nil {
				t.sse, _ = v["sseAlgorithm"].(string)
				t.kmsKey, _ = v["kmsKeyArn"].(string)
				w.WriteHeader(204)
				return
			}
		}
		writeCommitErr(w, err)
	case sub == "tags" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"tags": t.tags})
	case sub == "tags":
		if err := applyTags(t.tags, r, q); err != nil {
			writeCommitErr(w, err)
			return
		}
		w.WriteHeader(204)
	default:
		iceErr(w, 404, "NotFound", "no such route in test catalog")
	}
}

func (c *Catalog) handleViews(w http.ResponseWriter, r *http.Request, wh *whState, ns *nsState, rest []string) {
	if ns.views == nil {
		ns.views = map[string]*viewState{}
	}
	if len(rest) == 0 {
		if r.Method == "POST" {
			body, err := readGeneric(r)
			if err != nil {
				writeCommitErr(w, err)
				return
			}
			name, _ := body["name"].(string)
			if ns.views[name] != nil || ns.tbl[name] != nil {
				iceErr(w, 409, "AlreadyExistsException", "a table or view already exists: "+name)
				return
			}
			v, err := createView(wh.name, ns.levels, body)
			if err != nil {
				writeCommitErr(w, err)
				return
			}
			ns.views[name] = v
			writeJSON(w, 200, map[string]any{"metadata": v.metadata, "metadata-location": v.metaLoc, "config": map[string]any{}})
			return
		}
		ids := []any{}
		for n := range ns.views {
			ids = append(ids, map[string]any{"namespace": ns.levels, "name": n})
		}
		writeJSON(w, 200, map[string]any{"identifiers": ids})
		return
	}
	v, ok := ns.views[rest[0]]
	if !ok {
		iceErr(w, 404, "NoSuchViewException", "view does not exist: "+rest[0])
		return
	}
	switch r.Method {
	case "GET":
		writeJSON(w, 200, map[string]any{"metadata": v.metadata, "metadata-location": v.metaLoc, "config": map[string]any{}})
	case "POST":
		body, err := readGeneric(r)
		if err == nil {
			if err = commitView(v, arr(body["requirements"]), arr(body["updates"])); err == nil {
				writeJSON(w, 200, map[string]any{"metadata": v.metadata, "metadata-location": v.metaLoc})
				return
			}
		}
		writeCommitErr(w, err)
	case "DELETE":
		delete(ns.views, rest[0])
		w.WriteHeader(204)
	}
}

// register creates a catalog entry for an existing metadata file.
func (c *Catalog) register(w http.ResponseWriter, r *http.Request, wh *whState, ns *nsState, kind string) {
	body, err := readGeneric(r)
	if err != nil {
		writeCommitErr(w, err)
		return
	}
	name, _ := body["name"].(string)
	loc, _ := body["metadata-location"].(string)
	if !strings.HasPrefix(loc, "s3://"+wh.name+"/") {
		iceErr(w, 400, "BadRequestException", "metadata-location must be inside the warehouse bucket")
		return
	}
	if strings.Contains(loc, "purged") {
		iceErr(w, 404, "NotFoundException", "metadata file does not exist (data may have been purged)")
		return
	}
	if kind == "table" {
		if ns.tbl == nil {
			ns.tbl = map[string]*tableState{}
		}
		if ns.tbl[name] != nil && body["overwrite"] != true {
			iceErr(w, 409, "AlreadyExistsException", "table already exists: "+name)
			return
		}
		t := newTable(wh.name, ns.levels, name, 5000, 1<<22, len(ns.tbl))
		t.metaLoc = loc
		ns.tbl[name] = t
		ns.recompute()
		writeJSON(w, 200, map[string]any{"metadata": t.metadata, "metadata-location": t.metaLoc})
		return
	}
	if ns.views == nil {
		ns.views = map[string]*viewState{}
	}
	if ns.views[name] != nil {
		iceErr(w, 409, "AlreadyExistsException", "view already exists: "+name)
		return
	}
	v := newView(wh.name, ns.levels, name, strings.Join(ns.levels, ".")+".source")
	v.metaLoc = loc
	ns.views[name] = v
	writeJSON(w, 200, map[string]any{"metadata": v.metadata, "metadata-location": v.metaLoc})
}

// warehouseSettings serves encryption, tags and maintenance for a warehouse.
func (c *Catalog) warehouseSettings(w http.ResponseWriter, r *http.Request, wh *whState, what string, q url.Values) {
	switch {
	case what == "encryption" && r.Method == "GET":
		if wh.sse == "" {
			iceErr(w, 404, "NotFoundException", "no default encryption configured")
			return
		}
		cfg := map[string]any{"sseAlgorithm": wh.sse}
		if wh.kmsKey != "" {
			cfg["kmsKeyArn"] = wh.kmsKey
		}
		writeJSON(w, 200, map[string]any{"encryptionConfiguration": cfg})
	case what == "encryption" && r.Method == "PUT":
		body, err := readGeneric(r)
		if err == nil {
			var v map[string]any
			if v, err = encryptionValue(body); err == nil {
				wh.sse, _ = v["sseAlgorithm"].(string)
				wh.kmsKey, _ = v["kmsKeyArn"].(string)
				w.WriteHeader(204)
				return
			}
		}
		writeCommitErr(w, err)
	case what == "encryption" && r.Method == "DELETE":
		wh.sse, wh.kmsKey = "", ""
		w.WriteHeader(204)
	case what == "tags" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"tags": wh.tags})
	case what == "tags":
		if err := applyTags(wh.tags, r, q); err != nil {
			writeCommitErr(w, err)
			return
		}
		w.WriteHeader(204)
	case what == "maintenance" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"configuration": wh.maintCfg})
	case strings.HasPrefix(what, "maintenance/") && r.Method == "PUT":
		body, err := readGeneric(r)
		if err == nil {
			var v map[string]any
			if v, err = maintenanceValue(body); err == nil {
				wh.maintCfg[strings.TrimPrefix(what, "maintenance/")] = v
				w.WriteHeader(204)
				return
			}
		}
		writeCommitErr(w, err)
	default:
		iceErr(w, 404, "NotFound", "no such route in test catalog")
	}
}
