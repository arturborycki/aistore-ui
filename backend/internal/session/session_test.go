package session

import (
	"bytes"
	"context"
	"testing"
	"time"
)

func key(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

func TestKeyringRoundTripTamperAndRotation(t *testing.T) {
	old, _ := NewKeyring([]KeyMaterial{{ID: "old", Key: key(1)}})
	blob, err := old.Seal([]byte("secret"), []byte("ad"))
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(blob, []byte("secret")) {
		t.Fatal("plaintext visible in ciphertext")
	}
	if _, err := old.Open(blob, []byte("other-ad")); err == nil {
		t.Fatal("associated data not enforced")
	}
	tampered := append([]byte(nil), blob...)
	tampered[len(tampered)-1] ^= 1
	if _, err := old.Open(tampered, []byte("ad")); err == nil {
		t.Fatal("tampering not detected")
	}
	// Rotation: a new primary key still opens blobs sealed with the old one.
	rotated, _ := NewKeyring([]KeyMaterial{{ID: "new", Key: key(2)}, {ID: "old", Key: key(1)}})
	pt, err := rotated.Open(blob, []byte("ad"))
	if err != nil || string(pt) != "secret" {
		t.Fatalf("rotation open: %v", err)
	}
	fresh, _ := rotated.Seal([]byte("x"), nil)
	if _, err := old.Open(fresh, nil); err == nil {
		t.Fatal("old keyring opened blob sealed with unknown key")
	}
}

func TestManagerStoresOnlyCiphertextAndExpires(t *testing.T) {
	st := NewMemoryStore()
	defer st.Close()
	kr, _ := NewKeyring([]KeyMaterial{{ID: "k", Key: key(3)}})
	m := NewManager(st, kr, 30*time.Minute, time.Hour)
	now := time.Now()
	m.nowFunc = func() time.Time { return now }

	id, err := m.Create(context.Background(), &Session{
		User:  User{Subject: "alice", Username: "alice"},
		Creds: map[string]*Credentials{"dev": {AccessKey: "AK", SecretKey: "VERYSECRETVALUE", SessionToken: "TOK", Expiration: now.Add(time.Hour)}},
	})
	if err != nil {
		t.Fatal(err)
	}
	st.mu.Lock()
	for k, v := range st.data {
		if bytes.Contains(v.v, []byte("VERYSECRETVALUE")) || bytes.Contains(v.v, []byte("alice")) {
			t.Fatal("store holds plaintext")
		}
		if bytes.Contains([]byte(k), []byte(id)) {
			t.Fatal("store key reveals the session id")
		}
	}
	st.mu.Unlock()

	s, err := m.Load(context.Background(), id)
	if err != nil || s.Creds["dev"].SecretKey != "VERYSECRETVALUE" || s.CSRFToken == "" {
		t.Fatalf("load: %v", err)
	}
	// Idle timeout.
	now = now.Add(31 * time.Minute)
	if _, err := m.Load(context.Background(), id); err != ErrNotFound {
		t.Fatalf("idle session still valid: %v", err)
	}
	// Malformed IDs are rejected without touching the store.
	if _, err := m.Load(context.Background(), "short"); err != ErrNotFound {
		t.Fatal("malformed id accepted")
	}
}
