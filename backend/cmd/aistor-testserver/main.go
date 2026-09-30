// Command aistor-testserver runs the in-memory AIStor test double for
// end-to-end browser tests (e2e/). It is never included in the product image.
//
// Users: alice/alice-password (full access, admin), bob/bob-password (read-only).
// Both work via LDAP and access-key sign-in.
package main

import (
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strings"

	"github.com/arturborycki/aistore-ui/backend/internal/aistortest"
)

func main() {
	addr := flag.String("addr", "127.0.0.1:9000", "listen address")
	control := flag.String("control", "127.0.0.1:9001", "listen address of the test control API (empty disables it)")
	flag.Parse()

	cat := aistortest.NewCatalog()
	cat.Seed("analytics", map[string]string{"owner": "data-platform", "description": "Company-wide analytics tables", "environment": "production"}, map[string][3]int64{
		"sales.orders":      {12, 48_000_000, 9_800_000_000},
		"sales.returns":     {3, 1_200_000, 310_000_000},
		"finance.ledger.q3": {7, 9_400_000, 2_100_000_000},
		"marketing":         {5, 3_300_000, 740_000_000},
	})
	cat.Seed("ml-features", map[string]string{"owner": "ml-team"}, map[string][3]int64{
		"embeddings":   {4, 220_000_000, 41_000_000_000},
		"training.raw": {9, 80_000_000, 12_500_000_000},
	})
	cat.Seed("staging", nil, map[string][3]int64{"scratch": {1, 12_000, 4_000_000}})
	cat.Seed("iot-telemetry", map[string]string{"owner": "devices"}, map[string][3]int64{"events.2026": {24, 1_900_000_000, 88_000_000_000}})

	f := aistortest.New(
		&aistortest.User{AccessKey: "alice", SecretKey: "alice-password", LDAPPass: "alice-password", Allowed: []string{"*"}},
		&aistortest.User{AccessKey: "bob", SecretKey: "bob-password", LDAPPass: "bob-password", Allowed: []string{"GET *"}},
	)
	f.Handler = func(w http.ResponseWriter, r *http.Request, _ string) { cat.Handle(w, r) }
	// A versioned bucket for Apache Ossie semantic models (alice writes, bob reads).
	f.Objects = aistortest.NewObjectStore()
	f.Objects.CreateBucket("aistor-semantics", true)
	f.Server.Close()
	srv := &http.Server{Addr: *addr, Handler: f.Server.Config.Handler}
	go func() {
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}()
	if *control != "" {
		// Test hooks for e2e: POST /expire-credentials makes the next catalog
		// request fail with ExpiredToken, as when STS credentials run out.
		mux := http.NewServeMux()
		mux.HandleFunc("POST /expire-credentials", func(w http.ResponseWriter, _ *http.Request) {
			f.ExpireNextRequest()
			w.WriteHeader(http.StatusNoContent)
		})
		go func() {
			if err := http.ListenAndServe(*control, mux); err != nil {
				fmt.Fprintln(os.Stderr, "control:", err)
			}
		}()
	}
	fmt.Println("aistor-testserver listening on", *addr, strings.Repeat("-", 3), "users: alice (rw), bob (ro)")
	c := make(chan os.Signal, 1)
	signal.Notify(c, os.Interrupt)
	<-c
}
