// Package minisign implements the parts of the minisign format the spec
// relies on (spec/manifest.md §3): public keys, prehashed ("ED") detached
// signatures with trusted comments, and verification of both the file
// signature and the global signature.
//
// Verification is implemented directly on crypto/ed25519 and BLAKE2b-512 so
// the security boundary is small and strict; legacy non-prehashed ("Ed")
// signatures are rejected. Secret-key storage (scrypt-encrypted, compatible
// with the stock minisign tool) is delegated to aead.dev/minisign.
package minisign

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	upstream "aead.dev/minisign"
	"golang.org/x/crypto/blake2b"
)

const (
	algLegacy    = "Ed" // Ed25519 over the raw message: rejected
	algPrehashed = "ED" // Ed25519 over BLAKE2b-512(message)

	untrustedPrefix = "untrusted comment: "
	trustedPrefix   = "trusted comment: "

	// MaxSignatureBytes bounds the size of a signature file.
	MaxSignatureBytes = 4096
)

// Verification errors. All of them mean "do not trust".
var (
	ErrMalformedKey       = errors.New("minisign: malformed public key")
	ErrMalformedSignature = errors.New("minisign: malformed signature")
	ErrLegacySignature    = errors.New("minisign: legacy non-prehashed (Ed) signatures are not accepted")
	ErrKeyIDMismatch      = errors.New("minisign: signature was made by a different key")
	ErrBadSignature       = errors.New("minisign: signature verification failed")
	ErrBadGlobalSignature = errors.New("minisign: global signature (trusted comment) verification failed")
)

// PublicKey is a minisign Ed25519 public key.
type PublicKey struct {
	ID  [8]byte
	Key [ed25519.PublicKeySize]byte
}

// ParsePublicKey decodes the 56-character base64 form "Ed" || key id || key.
func ParsePublicKey(s string) (PublicKey, error) {
	var pk PublicKey
	if len(s) != 56 {
		return pk, fmt.Errorf("%w: want 56 base64 characters, got %d", ErrMalformedKey, len(s))
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(s)
	if err != nil || len(raw) != 42 {
		return pk, fmt.Errorf("%w: not valid base64", ErrMalformedKey)
	}
	if string(raw[:2]) != "Ed" {
		return pk, fmt.Errorf("%w: unknown algorithm", ErrMalformedKey)
	}
	copy(pk.ID[:], raw[2:10])
	copy(pk.Key[:], raw[10:])
	return pk, nil
}

// Bytes returns the 42 decoded bytes "Ed" || key id || key.
func (p PublicKey) Bytes() []byte {
	b := make([]byte, 0, 42)
	b = append(b, 'E', 'd')
	b = append(b, p.ID[:]...)
	return append(b, p.Key[:]...)
}

// String returns the minisign base64 encoding.
func (p PublicKey) String() string { return base64.StdEncoding.EncodeToString(p.Bytes()) }

// Fingerprint returns "SHA256:<hex>" over the 42 decoded bytes (manifest.md §2).
func (p PublicKey) Fingerprint() string {
	sum := sha256.Sum256(p.Bytes())
	return "SHA256:" + hex.EncodeToString(sum[:])
}

// KeyIDHex returns the key id the way the stock tool prints it (big-endian hex, upper case).
func (p PublicKey) KeyIDHex() string {
	var rev [8]byte
	for i := range p.ID {
		rev[7-i] = p.ID[i]
	}
	return strings.ToUpper(hex.EncodeToString(rev[:]))
}

// Equal reports whether two keys are identical (id and key material).
func (p PublicKey) Equal(o PublicKey) bool { return p == o }

// Fingerprint computes the fingerprint of an encoded key.
func Fingerprint(encoded string) (string, error) {
	pk, err := ParsePublicKey(encoded)
	if err != nil {
		return "", err
	}
	return pk.Fingerprint(), nil
}

// Signature is a parsed signature file.
type Signature struct {
	Algorithm        string
	KeyID            [8]byte
	Sig              [ed25519.SignatureSize]byte
	UntrustedComment string
	TrustedComment   string
	GlobalSig        [ed25519.SignatureSize]byte
}

// ParseSignature strictly parses the four-line signature file format.
func ParseSignature(text []byte) (Signature, error) {
	var s Signature
	if len(text) > MaxSignatureBytes {
		return s, fmt.Errorf("%w: too large", ErrMalformedSignature)
	}
	body := strings.TrimSuffix(string(text), "\n")
	lines := strings.Split(body, "\n")
	if len(lines) != 4 {
		return s, fmt.Errorf("%w: want 4 lines, got %d", ErrMalformedSignature, len(lines))
	}
	for i := range lines {
		lines[i] = strings.TrimSuffix(lines[i], "\r")
	}
	if !strings.HasPrefix(lines[0], untrustedPrefix) {
		return s, fmt.Errorf("%w: missing untrusted comment", ErrMalformedSignature)
	}
	if !strings.HasPrefix(lines[2], trustedPrefix) {
		return s, fmt.Errorf("%w: missing trusted comment", ErrMalformedSignature)
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(lines[1])
	if err != nil || len(raw) != 2+8+ed25519.SignatureSize {
		return s, fmt.Errorf("%w: bad signature line", ErrMalformedSignature)
	}
	global, err := base64.StdEncoding.Strict().DecodeString(lines[3])
	if err != nil || len(global) != ed25519.SignatureSize {
		return s, fmt.Errorf("%w: bad global signature line", ErrMalformedSignature)
	}
	s.Algorithm = string(raw[:2])
	copy(s.KeyID[:], raw[2:10])
	copy(s.Sig[:], raw[10:])
	copy(s.GlobalSig[:], global)
	s.UntrustedComment = strings.TrimPrefix(lines[0], untrustedPrefix)
	s.TrustedComment = strings.TrimPrefix(lines[2], trustedPrefix)
	return s, nil
}

// Verify checks a detached signature file over message with pk. It verifies
// the prehashed file signature and the global signature over
// signature || trusted_comment, and rejects the legacy "Ed" variant.
func Verify(pk PublicKey, message, signature []byte) error {
	s, err := ParseSignature(signature)
	if err != nil {
		return err
	}
	switch s.Algorithm {
	case algPrehashed:
	case algLegacy:
		return ErrLegacySignature
	default:
		return fmt.Errorf("%w: unknown algorithm %q", ErrMalformedSignature, s.Algorithm)
	}
	if s.KeyID != pk.ID {
		return ErrKeyIDMismatch
	}
	digest := blake2b.Sum512(message)
	if !ed25519.Verify(pk.Key[:], digest[:], s.Sig[:]) {
		return ErrBadSignature
	}
	global := append(append([]byte{}, s.Sig[:]...), s.TrustedComment...)
	if !ed25519.Verify(pk.Key[:], global, s.GlobalSig[:]) {
		return ErrBadGlobalSignature
	}
	return nil
}

// PrivateKey is a minisign secret key.
type PrivateKey struct{ k upstream.PrivateKey }

// Public returns the matching public key.
func (p PrivateKey) Public() PublicKey {
	up := p.k.Public().(upstream.PublicKey)
	pk, err := ParsePublicKey(up.String())
	if err != nil {
		panic("minisign: upstream produced an unparsable public key: " + err.Error())
	}
	return pk
}

// GenerateKey creates a fresh key pair.
func GenerateKey() (PrivateKey, error) {
	_, priv, err := upstream.GenerateKey(rand.Reader)
	if err != nil {
		return PrivateKey{}, fmt.Errorf("minisign: generate key: %w", err)
	}
	return PrivateKey{k: priv}, nil
}

// Marshal encodes the secret key in minisign's secret key file format. An
// empty password writes an unencrypted key (like `minisign -G -W`).
func (p PrivateKey) Marshal(password string) ([]byte, error) {
	var (
		out []byte
		err error
	)
	if password == "" {
		out, err = p.k.MarshalText()
	} else {
		out, err = upstream.EncryptKey(password, p.k)
	}
	if err != nil {
		return nil, fmt.Errorf("minisign: encode secret key: %w", err)
	}
	return append(bytes.TrimRight(out, "\n"), '\n'), nil
}

// IsEncrypted reports whether a secret key file needs a password.
func IsEncrypted(file []byte) bool { return upstream.IsEncrypted(file) }

// ParsePrivateKey decodes a secret key file, decrypting it when necessary.
func ParsePrivateKey(file []byte, password string) (PrivateKey, error) {
	if upstream.IsEncrypted(file) {
		k, err := upstream.DecryptKey(password, file)
		if err != nil {
			return PrivateKey{}, fmt.Errorf("minisign: decrypt secret key (wrong password?): %w", err)
		}
		return PrivateKey{k: k}, nil
	}
	var k upstream.PrivateKey
	if err := k.UnmarshalText(file); err != nil {
		return PrivateKey{}, fmt.Errorf("minisign: parse secret key: %w", err)
	}
	return PrivateKey{k: k}, nil
}

// Sign produces a prehashed detached signature file over message.
func Sign(p PrivateKey, message []byte, trustedComment, untrustedComment string) ([]byte, error) {
	if strings.ContainsAny(trustedComment+untrustedComment, "\r\n") {
		return nil, errors.New("minisign: comments must be single-line")
	}
	r := upstream.NewReader(bytes.NewReader(message))
	if _, err := io.Copy(io.Discard, r); err != nil {
		return nil, fmt.Errorf("minisign: hash message: %w", err)
	}
	sig := r.SignWithComments(p.k, trustedComment, untrustedComment)
	sig = append(bytes.TrimRight(sig, "\n"), '\n')
	if err := Verify(p.Public(), message, sig); err != nil {
		return nil, fmt.Errorf("minisign: self-check of fresh signature failed: %w", err)
	}
	return sig, nil
}
