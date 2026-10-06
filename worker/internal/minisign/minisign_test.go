package minisign

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	upstream "aead.dev/minisign"
)

func mustKey(t *testing.T) PrivateKey {
	t.Helper()
	k, err := GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestSignVerifyRoundTrip(t *testing.T) {
	k := mustKey(t)
	msg := []byte("hello lock\n")
	sig, err := Sign(k, msg, "agentfund lock v1 key:ABC", "u")
	if err != nil {
		t.Fatal(err)
	}
	if err := Verify(k.Public(), msg, sig); err != nil {
		t.Fatalf("verify: %v", err)
	}
	s, err := ParseSignature(sig)
	if err != nil || s.Algorithm != "ED" || s.TrustedComment != "agentfund lock v1 key:ABC" {
		t.Fatalf("parsed %+v err %v", s, err)
	}
	// The reference Go implementation agrees.
	var up upstream.PublicKey
	if err := up.UnmarshalText([]byte(k.Public().String())); err != nil {
		t.Fatal(err)
	}
	if !upstream.Verify(up, msg, sig) {
		t.Fatal("aead.dev/minisign rejects our signature")
	}
}

func TestVerifyRejections(t *testing.T) {
	k, other := mustKey(t), mustKey(t)
	msg := []byte("message")
	sig, _ := Sign(k, msg, "trusted", "untrusted")
	lines := strings.Split(strings.TrimSuffix(string(sig), "\n"), "\n")

	rebuild := func(mut func(l []string)) []byte {
		l := append([]string{}, lines...)
		mut(l)
		return []byte(strings.Join(l, "\n") + "\n")
	}
	cases := []struct {
		name string
		pk   PublicKey
		msg  []byte
		sig  []byte
		want error
	}{
		{"wrong message", k.Public(), []byte("messagf"), sig, ErrBadSignature},
		{"wrong key", other.Public(), msg, sig, ErrKeyIDMismatch},
		{"same key id, different key", PublicKey{ID: k.Public().ID, Key: other.Public().Key}, msg, sig, ErrBadSignature},
		{"trusted comment changed", k.Public(), msg, rebuild(func(l []string) { l[2] = "trusted comment: trusteD" }), ErrBadGlobalSignature},
		{"trusted comment extended", k.Public(), msg, rebuild(func(l []string) { l[2] += " " }), ErrBadGlobalSignature},
		{"global signature swapped", k.Public(), msg, rebuild(func(l []string) {
			o, _ := Sign(k, msg, "other", "untrusted")
			l[3] = strings.Split(string(o), "\n")[3]
		}), ErrBadGlobalSignature},
		{"three lines", k.Public(), msg, []byte(strings.Join(lines[:3], "\n") + "\n"), ErrMalformedSignature},
		{"five lines", k.Public(), msg, append(append([]byte{}, sig...), "x\n"...), ErrMalformedSignature},
		{"no untrusted prefix", k.Public(), msg, rebuild(func(l []string) { l[0] = "comment: x" }), ErrMalformedSignature},
		{"no trusted prefix", k.Public(), msg, rebuild(func(l []string) { l[2] = "trusted: x" }), ErrMalformedSignature},
		{"bad base64", k.Public(), msg, rebuild(func(l []string) { l[1] = "!!!" + l[1][3:] }), ErrMalformedSignature},
		{"short signature", k.Public(), msg, rebuild(func(l []string) { l[1] = l[1][:40] }), ErrMalformedSignature},
		{"empty", k.Public(), msg, nil, ErrMalformedSignature},
		{"oversized", k.Public(), msg, bytes.Repeat([]byte("a"), MaxSignatureBytes+1), ErrMalformedSignature},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := Verify(c.pk, c.msg, c.sig); !errors.Is(err, c.want) {
				t.Fatalf("got %v, want %v", err, c.want)
			}
		})
	}
	// The untrusted comment is, by design, not authenticated.
	if err := Verify(k.Public(), msg, rebuild(func(l []string) { l[0] = "untrusted comment: anything" })); err != nil {
		t.Fatalf("untrusted comment change must not matter: %v", err)
	}
}

func TestLegacySignatureRejected(t *testing.T) {
	_, upPriv, err := upstream.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	text, _ := upPriv.MarshalText()
	k, err := ParsePrivateKey(text, "")
	if err != nil {
		t.Fatal(err)
	}
	msg := []byte("legacy")
	legacy := upstream.SignWithComments(upPriv, msg, "t", "u") // non-prehashed "Ed"
	s, err := ParseSignature(legacy)
	if err != nil || s.Algorithm != "Ed" {
		t.Fatalf("expected a legacy signature, got %+v %v", s, err)
	}
	if err := Verify(k.Public(), msg, legacy); !errors.Is(err, ErrLegacySignature) {
		t.Fatalf("legacy signature: got %v", err)
	}
}

func TestPublicKeyParsing(t *testing.T) {
	k := mustKey(t)
	enc := k.Public().String()
	pk, err := ParsePublicKey(enc)
	if err != nil || pk != k.Public() {
		t.Fatalf("round trip: %v", err)
	}
	if !strings.HasPrefix(pk.Fingerprint(), "SHA256:") || len(pk.Fingerprint()) != 7+64 {
		t.Fatalf("fingerprint %q", pk.Fingerprint())
	}
	for _, bad := range []string{"", enc[:55], enc + "A", "RWQ" + strings.Repeat("=", 53), "AAAA" + enc[4:], strings.Replace(enc, enc[10:11], "*", 1)} {
		if _, err := ParsePublicKey(bad); !errors.Is(err, ErrMalformedKey) {
			t.Errorf("ParsePublicKey(%q) = %v", bad, err)
		}
	}
	// Spec example key and its fingerprint are stable.
	fp, err := Fingerprint("RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3")
	if err != nil || fp != "SHA256:"+fp[7:] || len(fp) != 71 {
		t.Fatalf("fingerprint of spec key: %q %v", fp, err)
	}
}

func TestPrivateKeyEncryption(t *testing.T) {
	if testing.Short() {
		t.Skip("scrypt with minisign's parameters is slow")
	}
	k := mustKey(t)
	enc, err := k.Marshal("correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if !IsEncrypted(enc) {
		t.Fatal("expected an encrypted key file")
	}
	if _, err := ParsePrivateKey(enc, "wrong"); err == nil {
		t.Fatal("wrong password accepted")
	}
	got, err := ParsePrivateKey(enc, "correct horse")
	if err != nil || got.Public() != k.Public() {
		t.Fatalf("decrypt: %v", err)
	}
	plain, _ := k.Marshal("")
	if IsEncrypted(plain) {
		t.Fatal("unencrypted key reported as encrypted")
	}
	if got, err := ParsePrivateKey(plain, ""); err != nil || got.Public() != k.Public() {
		t.Fatalf("plain: %v", err)
	}
}

// TestInteropWithStockTool cross-checks against the reference C implementation.
func TestInteropWithStockTool(t *testing.T) {
	tool, err := exec.LookPath("minisign")
	if err != nil {
		t.Skip("stock minisign tool not installed")
	}
	dir := t.TempDir()
	msgPath := filepath.Join(dir, "MANIFEST.lock")
	msg := []byte("{\n  \"lock_version\": 1\n}\n")
	if err := os.WriteFile(msgPath, msg, 0o644); err != nil {
		t.Fatal(err)
	}

	// Ours -> stock tool.
	k := mustKey(t)
	sig, err := Sign(k, msg, "agentfund lock v1 key:"+k.Public().KeyIDHex(), "from test")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(msgPath+".minisig", sig, 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(tool, "-Vm", msgPath, "-P", k.Public().String()).CombinedOutput(); err != nil {
		t.Fatalf("stock minisign rejects our signature: %v\n%s", err, out)
	}

	// Stock tool (unencrypted key, -W) -> ours; also our key parser reads its key file.
	pub, sec := filepath.Join(dir, "k.pub"), filepath.Join(dir, "k.key")
	if out, err := exec.Command(tool, "-G", "-W", "-f", "-p", pub, "-s", sec).CombinedOutput(); err != nil {
		t.Fatalf("minisign -G: %v\n%s", err, out)
	}
	other := filepath.Join(dir, "other.txt")
	if err := os.WriteFile(other, []byte("stock\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(tool, "-S", "-s", sec, "-m", other, "-t", "tc").CombinedOutput(); err != nil {
		t.Fatalf("minisign -S: %v\n%s", err, out)
	}
	pubFile, _ := os.ReadFile(pub)
	pubLines := strings.Split(strings.TrimSpace(string(pubFile)), "\n")
	pk, err := ParsePublicKey(pubLines[len(pubLines)-1])
	if err != nil {
		t.Fatal(err)
	}
	stockSig, _ := os.ReadFile(other + ".minisig")
	if err := Verify(pk, []byte("stock\n"), stockSig); err != nil {
		t.Fatalf("we reject the stock tool's signature: %v", err)
	}
	secFile, _ := os.ReadFile(sec)
	sk, err := ParsePrivateKey(secFile, "")
	if err != nil || sk.Public() != pk {
		t.Fatalf("parse stock secret key: %v", err)
	}
	// The stock tool reads a secret key file we wrote.
	ourSec := filepath.Join(dir, "ours.key")
	raw, _ := k.Marshal("")
	if err := os.WriteFile(ourSec, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command(tool, "-S", "-s", ourSec, "-m", other, "-x", filepath.Join(dir, "o.minisig")).CombinedOutput(); err != nil {
		t.Fatalf("stock minisign cannot use our key file: %v\n%s", err, out)
	}
	osig, _ := os.ReadFile(filepath.Join(dir, "o.minisig"))
	if err := Verify(k.Public(), []byte("stock\n"), osig); err != nil {
		t.Fatalf("signature by stock tool with our key: %v", err)
	}
}
