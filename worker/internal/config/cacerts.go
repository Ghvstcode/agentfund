package config

import (
	"bytes"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// maxCABundleBytes caps sandbox.extra_ca_certs. A corporate bundle is a few
// certificates; the full Mozilla set is about 220 KB.
const maxCABundleBytes = 1 << 20

const caKey = "global.sandbox.extra_ca_certs"

// expandHome resolves a leading "~/" against the user's home directory.
func expandHome(path string) (string, error) {
	if !strings.HasPrefix(path, "~/") {
		return path, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, path[2:]), nil
}

// ReadCACerts reads sandbox.extra_ca_certs: a PEM file of CA certificates the
// agent should trust in addition to the image's own roots (a TLS-inspecting
// corporate proxy's CA, say). It returns only the certificates, re-encoded,
// and refuses anything else, above all a private key, which would otherwise
// end up readable by the agent.
func ReadCACerts(path string) ([]byte, error) {
	p, err := expandHome(path)
	if err != nil {
		return nil, fmt.Errorf("%s: cannot expand %q: %w", caKey, path, err)
	}
	if !filepath.IsAbs(p) {
		return nil, fmt.Errorf("%s: %q is not an absolute path; use /full/path/ca.pem or ~/path/ca.pem", caKey, path)
	}
	st, err := os.Stat(p)
	if err != nil {
		return nil, fmt.Errorf("%s: %w; point it at a readable PEM file of CA certificates, or set it to \"\"", caKey, err)
	}
	if !st.Mode().IsRegular() {
		return nil, fmt.Errorf("%s: %s is not a regular file; point it at a PEM file of CA certificates", caKey, p)
	}
	if st.Size() > maxCABundleBytes {
		return nil, fmt.Errorf("%s: %s is %d bytes, more than the %d allowed; list only the CA certificates you need", caKey, p, st.Size(), maxCABundleBytes)
	}
	raw, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("%s: %w; make the file readable by the user running the worker", caKey, err)
	}
	var out bytes.Buffer
	n := 0
	for rest := raw; ; {
		var block *pem.Block
		block, rest = pem.Decode(rest)
		if block == nil {
			if bytes.Contains(rest, []byte("-----BEGIN")) {
				return nil, fmt.Errorf("%s: %s has a malformed PEM block after certificate %d", caKey, p, n)
			}
			break
		}
		if block.Type != "CERTIFICATE" {
			return nil, fmt.Errorf("%s: %s contains a %q block; the file must hold only CERTIFICATE blocks (never a private key)", caKey, p, block.Type)
		}
		if _, err := x509.ParseCertificate(block.Bytes); err != nil {
			return nil, fmt.Errorf("%s: certificate %d in %s does not parse: %w", caKey, n+1, p, err)
		}
		if err := pem.Encode(&out, &pem.Block{Type: "CERTIFICATE", Bytes: block.Bytes}); err != nil {
			return nil, err
		}
		n++
	}
	if n == 0 {
		return nil, fmt.Errorf("%s: no PEM certificates in %s; it must contain -----BEGIN CERTIFICATE----- blocks "+
			"(convert a DER file with: openssl x509 -inform der -in ca.cer -out ca.pem)", caKey, p)
	}
	return out.Bytes(), nil
}
