package config

import (
	"fmt"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"
	"unicode"
)

// EnvPrefix starts every configuration environment variable.
//
// Each setting can be given as AISTOR_UI_<PATH>, where PATH is its YAML path
// in upper snake case: server.publicUrl is AISTOR_UI_SERVER_PUBLIC_URL and
// auth.oidc.clientId is AISTOR_UI_AUTH_OIDC_CLIENT_ID. Lists are comma
// separated, maps are k=v pairs separated by commas, durations use Go syntax
// (90s, 12h). The first cluster is AISTOR_UI_CLUSTER_<FIELD> and the first
// session key is AISTOR_UI_SESSION_KEY_<FIELD>. Variables override the file.
const EnvPrefix = "AISTOR_UI_"

// envNotConfig are AISTOR_UI_* variables that are not configuration settings.
var envNotConfig = []string{"AISTOR_UI_CONFIG", "AISTOR_UI_DEBUG"}

// applyEnv overlays configuration settings from environment variables
// (environ is os.Environ()). It reports unknown AISTOR_UI_* variables, so a
// typo fails loudly as an unknown YAML key does.
func applyEnv(c *Config, environ []string) error {
	vars := map[string]string{}
	for _, kv := range environ {
		k, v, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, EnvPrefix) && !slices.Contains(envNotConfig, k) {
			vars[k] = v
		}
	}
	if len(vars) == 0 {
		return nil
	}
	used := map[string]bool{}
	var errs []string
	set := func(prefix string, v reflect.Value) {
		walkEnv(prefix, v, vars, used, &errs)
	}

	set(strings.TrimSuffix(EnvPrefix, "_"), reflect.ValueOf(c).Elem())
	if hasPrefixed(vars, EnvPrefix+"CLUSTER_") {
		if len(c.Clusters) == 0 {
			c.Clusters = append(c.Clusters, Cluster{})
		}
		set(EnvPrefix+"CLUSTER", reflect.ValueOf(&c.Clusters[0]).Elem())
	}
	if hasPrefixed(vars, EnvPrefix+"SESSION_KEY_") {
		if len(c.Session.Keys) == 0 {
			c.Session.Keys = append(c.Session.Keys, Key{ID: "env"})
		}
		set(EnvPrefix+"SESSION_KEY", reflect.ValueOf(&c.Session.Keys[0]).Elem())
	}

	for k := range vars {
		if !used[k] {
			errs = append(errs, fmt.Sprintf("%s is not a configuration setting", k))
		}
	}
	if len(errs) > 0 {
		slices.Sort(errs)
		return fmt.Errorf("environment: %s", strings.Join(errs, "; "))
	}
	return nil
}

func hasPrefixed(vars map[string]string, prefix string) bool {
	for k := range vars {
		if strings.HasPrefix(k, prefix) {
			return true
		}
	}
	return false
}

var durationType = reflect.TypeOf(time.Duration(0))

// walkEnv sets the fields of the struct v from vars named prefix_<FIELD>.
// Lists of structs (clusters, session keys) are handled by the caller.
func walkEnv(prefix string, v reflect.Value, vars map[string]string, used map[string]bool, errs *[]string) {
	t := v.Type()
	for i := range t.NumField() {
		f := t.Field(i)
		tag, _, _ := strings.Cut(f.Tag.Get("yaml"), ",")
		if !f.IsExported() || tag == "" || tag == "-" {
			continue
		}
		name := prefix + "_" + upperSnake(tag)
		fv := v.Field(i)
		if f.Type.Kind() == reflect.Struct {
			walkEnv(name, fv, vars, used, errs)
			continue
		}
		raw, ok := vars[name]
		if !ok {
			continue
		}
		used[name] = true
		if err := setFromString(fv, raw); err != nil {
			*errs = append(*errs, fmt.Sprintf("%s: %v", name, err))
		}
	}
}

func setFromString(v reflect.Value, raw string) error {
	if v.Type() == durationType {
		d, err := time.ParseDuration(strings.TrimSpace(raw))
		if err != nil {
			return err
		}
		v.SetInt(int64(d))
		return nil
	}
	switch v.Kind() {
	case reflect.String:
		v.SetString(raw)
	case reflect.Bool:
		b, err := strconv.ParseBool(strings.TrimSpace(raw))
		if err != nil {
			return fmt.Errorf("want true or false, got %q", raw)
		}
		v.SetBool(b)
	case reflect.Int, reflect.Int64:
		n, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil {
			return fmt.Errorf("want a whole number, got %q", raw)
		}
		v.SetInt(n)
	case reflect.Slice:
		if v.Type().Elem().Kind() != reflect.String {
			return fmt.Errorf("not settable from the environment")
		}
		v.Set(reflect.ValueOf(splitList(raw)))
	case reflect.Map:
		m := map[string]string{}
		for _, kv := range splitList(raw) {
			k, val, ok := strings.Cut(kv, "=")
			if !ok || strings.TrimSpace(k) == "" {
				return fmt.Errorf("want key=value pairs, got %q", kv)
			}
			m[strings.TrimSpace(k)] = strings.TrimSpace(val)
		}
		v.Set(reflect.ValueOf(m))
	default:
		return fmt.Errorf("not settable from the environment")
	}
	return nil
}

// splitList splits a comma-separated list, dropping empty items.
func splitList(raw string) []string {
	out := []string{}
	for _, s := range strings.Split(raw, ",") {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

// upperSnake turns a YAML key into its environment form: publicUrl → PUBLIC_URL.
func upperSnake(s string) string {
	var b strings.Builder
	r := []rune(s)
	for i, c := range r {
		if i > 0 && unicode.IsUpper(c) && (unicode.IsLower(r[i-1]) || unicode.IsDigit(r[i-1])) {
			b.WriteByte('_')
		}
		b.WriteRune(unicode.ToUpper(c))
	}
	return b.String()
}

// EnvNames lists every configuration environment variable, for documentation
// and tests.
func EnvNames() []string {
	names := map[string]bool{}
	collectNames(strings.TrimSuffix(EnvPrefix, "_"), reflect.TypeOf(Config{}), names)
	collectNames(EnvPrefix+"CLUSTER", reflect.TypeOf(Cluster{}), names)
	collectNames(EnvPrefix+"SESSION_KEY", reflect.TypeOf(Key{}), names)
	out := make([]string, 0, len(names))
	for k := range names {
		out = append(out, k)
	}
	slices.Sort(out)
	return out
}

func collectNames(prefix string, t reflect.Type, out map[string]bool) {
	for i := range t.NumField() {
		f := t.Field(i)
		tag, _, _ := strings.Cut(f.Tag.Get("yaml"), ",")
		if !f.IsExported() || tag == "" || tag == "-" {
			continue
		}
		name := prefix + "_" + upperSnake(tag)
		switch {
		case f.Type.Kind() == reflect.Struct:
			collectNames(name, f.Type, out)
		case f.Type.Kind() == reflect.Slice && f.Type.Elem().Kind() == reflect.Struct:
			// clusters and session keys: see AISTOR_UI_CLUSTER_* and AISTOR_UI_SESSION_KEY_*
		default:
			out[name] = true
		}
	}
}
