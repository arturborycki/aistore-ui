package audit

import (
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"
)

func TestSignedWebhookDelivery(t *testing.T) {
	got := make(chan bool, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got <- VerifySignature([]byte("s3cret"), r.Header.Get(HeaderTimestamp), r.Header.Get(HeaderSignature), body, time.Minute)
	}))
	defer srv.Close()
	l := NewLogger(slog.New(slog.NewTextHandler(io.Discard, nil)), NewMemoryStore(10), srv.URL, WithWebhookSecret("s3cret"))
	l.Record(context.Background(), &Record{Kind: "catalog", Actor: Actor{Subject: "a", Username: "alice"}})
	select {
	case ok := <-got:
		if !ok {
			t.Fatal("signature did not verify")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no delivery")
	}
	// Tampered bodies and stale timestamps are rejected.
	ts := "1"
	if VerifySignature([]byte("s3cret"), ts, Sign([]byte("s3cret"), ts, []byte("x")), []byte("x"), time.Minute) {
		t.Fatal("stale timestamp accepted")
	}
	now := time.Now().Unix()
	tsNow := strconv.FormatInt(now, 10)
	if VerifySignature([]byte("s3cret"), tsNow, Sign([]byte("s3cret"), tsNow, []byte("x")), []byte("y"), time.Minute) {
		t.Fatal("tampered body accepted")
	}
}
