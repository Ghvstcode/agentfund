// Package minisign implements the parts of the minisign format the spec
// relies on (spec/manifest.md §3): public keys, prehashed ("ED") detached
// signatures with trusted comments, and verification of both the file
// signature and the global signature.
//
// Verification is implemented directly on crypto/ed25519 and BLAKE2b-512 so
// the security boundary is small and strict; legacy non-prehashed ("Ed")
// signatures are rejected. Secret-key storage (scrypt-encrypted, compatible
// with the stock minisign tool): the unencrypted layout and decryption come
// from aead.dev/minisign; encryption is written here so its scrypt cost can be
// chosen (the cost is recorded in the key file).
package minisign

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	upstream "aead.dev/minisign"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
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

// KDF holds the scrypt cost of an encrypted secret key in libsodium's terms
// (crypto_pwhash_scryptsalsa208sha256 opslimit/memlimit). The values are
// stored in the key file, so any minisign implementation can decrypt a key
// whatever cost it was written with.
type KDF struct {
	OpsLimit uint64
	MemLimit uint64
}

var (
	// KDFSensitive is what the stock minisign tool uses and what `keygen`
	// writes: N = 2^20, r = 8 — one gibibyte of memory and a few seconds.
	KDFSensitive = KDF{OpsLimit: 33554432, MemLimit: 1073741824}
	// KDFInteractive is libsodium's cheap setting (N = 2^14, 16 MiB).
	KDFInteractive = KDF{OpsLimit: 524288, MemLimit: 16777216}
)

// scryptParams mirrors libsodium's pickparams (r is always 8).
func (k KDF) scryptParams() (n, r, p int) {
	ops, mem := k.OpsLimit, k.MemLimit
	if ops < 1<<15 {
		ops = 1 << 15
	}
	r = 8
	if ops < mem/32 {
		p = 1
		for i := 1; i < 63; i++ {
			if n = 1 << i; uint64(n) > ops/(8*uint64(r)) {
				break
			}
		}
		return n, r, p
	}
	for i := 1; i < 63; i++ {
		if n = 1 << i; uint64(n) > mem/(256*uint64(r)) {
			break
		}
	}
	if rp := (ops / 4) / uint64(n); rp < 0x3fffffff {
		p = int(rp) / r
	} else {
		p = 0x3fffffff / r
	}
	return n, r, p
}

// Marshal encodes the secret key in minisign's secret key file format. An
// empty password writes an unencrypted key (like `minisign -G -W`); otherwise
// the key is encrypted with KDFSensitive, like the stock tool does.
func (p PrivateKey) Marshal(password string) ([]byte, error) {
	return p.MarshalKDF(password, KDFSensitive)
}

// Layout of the 158 decoded bytes of a secret key file:
// sig alg(2) kdf alg(2) checksum alg(2) salt(32) opslimit(8) memlimit(8)
// then 104 bytes: key id(8) secret key(64) checksum(32), XORed with the scrypt
// output when encrypted. checksum = BLAKE2b-256(sig alg || key id || secret key).
const (
	skSize     = 158
	skSaltOff  = 6
	skOpsOff   = 38
	skMemOff   = 46
	skBodyOff  = 54
	skBodySize = 104
)

// MarshalKDF is Marshal with an explicit scrypt cost.
func (p PrivateKey) MarshalKDF(password string, kdf KDF) ([]byte, error) {
	plain, err := p.k.MarshalText()
	if err != nil {
		return nil, fmt.Errorf("minisign: encode secret key: %w", err)
	}
	if password == "" {
		return append(bytes.TrimRight(plain, "\n"), '\n'), nil
	}
	lines := strings.Split(strings.TrimRight(string(plain), "\n"), "\n")
	raw, err := base64.StdEncoding.DecodeString(lines[len(lines)-1])
	if err != nil || len(raw) != skSize {
		return nil, errors.New("minisign: encode secret key: unexpected plain key layout")
	}
	copy(raw[2:4], "Sc")
	copy(raw[4:6], "B2")
	salt := raw[skSaltOff:skOpsOff]
	if _, err := rand.Read(salt); err != nil {
		return nil, fmt.Errorf("minisign: encode secret key: %w", err)
	}
	binary.LittleEndian.PutUint64(raw[skOpsOff:], kdf.OpsLimit)
	binary.LittleEndian.PutUint64(raw[skMemOff:], kdf.MemLimit)
	body := raw[skBodyOff:]
	sum := blake2b.Sum256(append(append([]byte{}, raw[:2]...), body[:72]...))
	copy(body[72:], sum[:])
	n, r, pp := kdf.scryptParams()
	stream, err := scrypt.Key([]byte(password), salt, n, r, pp, skBodySize)
	if err != nil {
		return nil, fmt.Errorf("minisign: derive key-encryption key: %w", err)
	}
	for i := range stream {
		body[i] ^= stream[i]
	}
	return []byte("untrusted comment: minisign encrypted secret key\n" + base64.StdEncoding.EncodeToString(raw) + "\n"), nil
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
