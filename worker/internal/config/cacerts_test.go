package config

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// testCA returns a self-signed CA certificate and its private key, both PEM.
func testCA(t *testing.T, name string) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	kder, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: kder})
}

func writeFile(t *testing.T, name string, data []byte) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestReadCACertsKeepsOnlyCertificates(t *testing.T) {
	a, _ := testCA(t, "corp-root")
	b, _ := testCA(t, "corp-intermediate")
	// Comments between blocks are common in exported bundles.
	p := writeFile(t, "bundle.pem", append(append([]byte("# Corp root\n"), a...), append([]byte("\n# Intermediate\n"), b...)...))
	got, err := ReadCACerts(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, append(append([]byte{}, a...), b...)) {
		t.Fatalf("certificates not returned verbatim:\n%s", got)
	}
}

func TestReadCACertsExpandsHome(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	a, _ := testCA(t, "corp-root")
	if err := os.WriteFile(filepath.Join(home, "ca.pem"), a, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCACerts("~/ca.pem"); err != nil {
		t.Fatal(err)
	}
}

func TestReadCACertsRejects(t *testing.T) {
	cert, key := testCA(t, "corp-root")
	dir := t.TempDir()
	unreadable := writeFile(t, "unreadable.pem", cert)
	os.Chmod(unreadable, 0)
	garbled := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: []byte("not DER")})
	for name, tc := range map[string]struct{ path, want string }{
		"relative path":   {"ca.pem", "not an absolute path"},
		"missing file":    {filepath.Join(dir, "nope.pem"), "no such file"},
		"directory":       {dir, "not a regular file"},
		"empty file":      {writeFile(t, "empty.pem", nil), "no PEM certificates"},
		"DER, not PEM":    {writeFile(t, "ca.cer", []byte{0x30, 0x82, 0x01, 0x0a}), "openssl x509 -inform der"},
		"private key":     {writeFile(t, "key.pem", append(append([]byte{}, cert...), key...)), "never a private key"},
		"unparsable cert": {writeFile(t, "bad.pem", garbled), "does not parse"},
		"truncated block": {writeFile(t, "cut.pem", append(append([]byte{}, cert...), cert[:40]...)), "malformed PEM block after certificate 1"},
		"too large":       {writeFile(t, "big.pem", bytes.Repeat([]byte("#"), maxCABundleBytes+1)), "more than"},
		"unreadable file": {unreadable, "permission denied"},
	} {
		if name == "unreadable file" && os.Geteuid() == 0 {
			continue
		}
		_, err := ReadCACerts(tc.path)
		if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "global.sandbox.extra_ca_certs") {
			t.Errorf("%s: got %v, want an error naming the key and containing %q", name, err, tc.want)
		}
	}
}

func TestLoadValidatesExtraCACerts(t *testing.T) {
	cert, key := testCA(t, "corp-root")
	good := writeFile(t, "ca.pem", cert)
	p := filepath.Join(t.TempDir(), "config.yaml")
	os.WriteFile(p, []byte("global:\n  sandbox: {extra_ca_certs: "+good+"}\n"), 0o600)
	c, err := LoadFile(p)
	if err != nil || c.Global.Sandbox.ExtraCACerts != good {
		t.Fatalf("valid bundle: %v %+v", err, c)
	}
	// Round trip through the commented writer.
	if err := c.SaveFile(p); err != nil {
		t.Fatal(err)
	}
	if c2, err := LoadFile(p); err != nil || c2.Global.Sandbox.ExtraCACerts != good {
		t.Fatalf("round trip: %v", err)
	}
	bad := writeFile(t, "key.pem", key)
	os.WriteFile(p, []byte("global:\n  sandbox: {extra_ca_certs: "+bad+"}\n"), 0o600)
	if _, err := LoadFile(p); err == nil || !strings.Contains(err.Error(), "never a private key") {
		t.Fatalf("a private key was accepted: %v", err)
	}
}
