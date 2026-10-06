package lockfile

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/spec"
)

func manifest(id, deps string) []byte {
	return []byte("spec_version: 1\nid: " + id + "\ntitle: t\nprompt: do the thing\nscope:\n  write: [a.txt]\nverify: test -f a.txt\nmax_tokens: 1000\n" + deps)
}

func TestBuildMarshalParseRoundTrip(t *testing.T) {
	l, err := Build(map[string][]byte{
		"tasks/0002-b.yaml": manifest("0002-b", "depends_on: [0001-a]\n"),
		"tasks/0001-a.yaml": manifest("0001-a", ""),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := l.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"lock_version\": 1,\n  \"spec_version\": 1,\n  \"manifests\": [\n    {\n      \"path\": \"tasks/0001-a.yaml\",\n      \"id\": \"0001-a\",\n      \"sha256\": \"" +
		SHA256Hex(manifest("0001-a", "")) + "\"\n    },\n    {\n      \"path\": \"tasks/0002-b.yaml\",\n      \"id\": \"0002-b\",\n      \"sha256\": \"" +
		SHA256Hex(manifest("0002-b", "depends_on: [0001-a]\n")) + "\"\n    }\n  ],\n  \"rotations\": []\n}\n"
	if string(raw) != want {
		t.Fatalf("lock bytes:\n%s\nwant:\n%s", raw, want)
	}
	back, err := Parse(raw)
	if err != nil || len(back.Manifests) != 2 || back.Manifests[0].ID != "0001-a" {
		t.Fatalf("parse: %+v %v", back, err)
	}
	if e, ok := back.Find("0002-b"); !ok || e.Path != "tasks/0002-b.yaml" {
		t.Fatalf("find: %+v", e)
	}
	if _, ok := back.Find("0009-x"); ok {
		t.Fatal("found a missing id")
	}
}

func TestBuildRejects(t *testing.T) {
	cases := map[string]map[string][]byte{
		"id mismatch":        {"tasks/0001-a.yaml": manifest("0002-b", "")},
		"bad path":           {"tasks/a.yaml": manifest("0001-a", "")},
		"invalid manifest":   {"tasks/0001-a.yaml": []byte("spec_version: 1\n")},
		"unknown dependency": {"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0005-zz]\n")},
		"self cycle":         {"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0001-a]\n")},
		"two-cycle": {"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0002-b]\n"),
			"tasks/0002-b.yaml": manifest("0002-b", "depends_on: [0001-a]\n")},
	}
	for name, m := range cases {
		if l, err := Build(m, nil); err == nil {
			t.Errorf("%s: accepted %+v", name, l)
		}
	}
	if err := CheckDependencies(map[string][]string{"a": {"b"}, "b": {"c"}, "c": nil, "d": {"b", "c"}}); err != nil {
		t.Errorf("a DAG was rejected: %v", err)
	}
	if err := CheckDependencies(map[string][]string{"a": {"b"}, "b": {"c"}, "c": {"a"}}); err == nil || !strings.Contains(err.Error(), "cycle") {
		t.Errorf("three-cycle: %v", err)
	}
}

func TestParseRejects(t *testing.T) {
	h := strings.Repeat("a", 64)
	entry := func(p, id string) string { return `{"path":"` + p + `","id":"` + id + `","sha256":"` + h + `"}` }
	cases := map[string]string{
		"not json":       "nope",
		"trailing data":  `{"lock_version":1,"spec_version":1,"manifests":[]} {}`,
		"wrong version":  `{"lock_version":2,"spec_version":1,"manifests":[]}`,
		"missing field":  `{"lock_version":1,"manifests":[]}`,
		"extra field":    `{"lock_version":1,"spec_version":1,"manifests":[],"x":1}`,
		"unsorted":       `{"lock_version":1,"spec_version":1,"manifests":[` + entry("tasks/0002-b.yaml", "0002-b") + `,` + entry("tasks/0001-a.yaml", "0001-a") + `]}`,
		"duplicate":      `{"lock_version":1,"spec_version":1,"manifests":[` + entry("tasks/0001-a.yaml", "0001-a") + `,` + entry("tasks/0001-a.yaml", "0001-a") + `]}`,
		"id != path":     `{"lock_version":1,"spec_version":1,"manifests":[` + entry("tasks/0001-a.yaml", "0002-b") + `]}`,
		"path traversal": `{"lock_version":1,"spec_version":1,"manifests":[` + entry("tasks/../0001-a.yaml", "0001-a") + `]}`,
		"uppercase hash": `{"lock_version":1,"spec_version":1,"manifests":[{"path":"tasks/0001-a.yaml","id":"0001-a","sha256":"` + strings.Repeat("A", 64) + `"}]}`,
		"17 rotations":   `{"lock_version":1,"spec_version":1,"manifests":[],"rotations":[` + strings.TrimSuffix(strings.Repeat(`{"from":"`+strings.Repeat("A", 56)+`","to":"`+strings.Repeat("B", 56)+`","signature":"x"},`, 17), ",") + `]}`,
	}
	for name, raw := range cases {
		if l, err := Parse([]byte(raw)); err == nil {
			t.Errorf("%s: accepted %+v", name, l)
		}
	}
	if _, err := Parse(bytes.Repeat([]byte(" "), MaxLockBytes+1)); err == nil {
		t.Error("oversized lock accepted")
	}
}

func TestRotationMessageIsExact(t *testing.T) {
	got := string(RotationMessage("AAA", "BBB"))
	if got != "agentfund-key-rotation-v1\nfrom: AAA\nto: BBB\n" {
		t.Fatalf("%q", got)
	}
}

// The committed example project must verify with the committed example key.
func TestCommittedExampleLockVerifies(t *testing.T) {
	root := filepath.Join("..", "..", "..", "examples", "hello-project")
	lockRaw, err := os.ReadFile(filepath.Join(root, "tasks", "MANIFEST.lock"))
	if err != nil {
		t.Skipf("example lock not present yet: %v", err)
	}
	sig, err := os.ReadFile(filepath.Join(root, "tasks", "MANIFEST.lock.minisig"))
	if err != nil {
		t.Fatal(err)
	}
	descRaw, _ := os.ReadFile(filepath.Join(root, "agentfund.yaml"))
	desc, err := spec.ParseDescriptor(descRaw)
	if err != nil {
		t.Fatal(err)
	}
	pk, err := minisign.ParsePublicKey(desc.Pubkey)
	if err != nil {
		t.Fatal(err)
	}
	signer, links, err := Authenticate(pk, lockRaw, sig)
	if err != nil || signer != pk || links != 0 {
		t.Fatalf("example lock does not verify against agentfund.yaml's key: %v", err)
	}
	lock, err := Parse(lockRaw)
	if err != nil {
		t.Fatal(err)
	}
	files, _ := filepath.Glob(filepath.Join(root, "tasks", "*.yaml"))
	if len(files) != len(lock.Manifests) {
		t.Fatalf("%d manifests on disk, %d in the lock", len(files), len(lock.Manifests))
	}
	for _, e := range lock.Manifests {
		raw, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(e.Path)))
		if err != nil || SHA256Hex(raw) != e.SHA256 {
			t.Errorf("%s: hash mismatch or missing (%v) — re-run `agentfund sign examples/hello-project/tasks --key examples/hello-project/.example-key/example.key`", e.Path, err)
		}
	}
	// The secret key next to it is the matching, unencrypted test key.
	secRaw, err := os.ReadFile(filepath.Join(root, ".example-key", "example.key"))
	if err != nil {
		t.Fatal(err)
	}
	sk, err := minisign.ParsePrivateKey(secRaw, "")
	if err != nil || sk.Public() != pk {
		t.Fatalf("example secret key does not match agentfund.yaml: %v", err)
	}
}
