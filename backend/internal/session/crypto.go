package session

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"errors"
	"fmt"
)

// Keyring encrypts with the primary key and decrypts with any known key,
// which allows zero-downtime key rotation.
type Keyring struct {
	primary string
	aeads   map[string]cipher.AEAD
}

type KeyMaterial struct {
	ID  string
	Key []byte
}

func NewKeyring(keys []KeyMaterial) (*Keyring, error) {
	if len(keys) == 0 {
		return nil, errors.New("keyring: no keys")
	}
	kr := &Keyring{primary: keys[0].ID, aeads: map[string]cipher.AEAD{}}
	for _, k := range keys {
		if len(k.Key) != 32 {
			return nil, fmt.Errorf("keyring: key %q must be 32 bytes", k.ID)
		}
		if len(k.ID) == 0 || len(k.ID) > 255 {
			return nil, fmt.Errorf("keyring: invalid key id %q", k.ID)
		}
		block, err := aes.NewCipher(k.Key)
		if err != nil {
			return nil, err
		}
		a, err := cipher.NewGCM(block)
		if err != nil {
			return nil, err
		}
		kr.aeads[k.ID] = a
	}
	return kr, nil
}

// Seal encrypts plaintext. The associated data binds the ciphertext to its
// purpose (e.g. the storage key) so blobs cannot be swapped between records.
// Output layout: len(kid) | kid | nonce | ciphertext+tag.
func (k *Keyring) Seal(plaintext, ad []byte) ([]byte, error) {
	a := k.aeads[k.primary]
	nonce := make([]byte, a.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	out := make([]byte, 0, 1+len(k.primary)+len(nonce)+len(plaintext)+a.Overhead())
	out = append(out, byte(len(k.primary)))
	out = append(out, k.primary...)
	out = append(out, nonce...)
	return a.Seal(out, nonce, plaintext, ad), nil
}

var ErrDecrypt = errors.New("session: cannot decrypt")

func (k *Keyring) Open(blob, ad []byte) ([]byte, error) {
	if len(blob) < 1 {
		return nil, ErrDecrypt
	}
	n := int(blob[0])
	if len(blob) < 1+n {
		return nil, ErrDecrypt
	}
	a, ok := k.aeads[string(blob[1:1+n])]
	if !ok {
		return nil, ErrDecrypt
	}
	rest := blob[1+n:]
	if len(rest) < a.NonceSize()+a.Overhead() {
		return nil, ErrDecrypt
	}
	pt, err := a.Open(nil, rest[:a.NonceSize()], rest[a.NonceSize():], ad)
	if err != nil {
		return nil, ErrDecrypt
	}
	return pt, nil
}
