package lint

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const good = `spec_version: 1
id: %s
title: A task
prompt: |
  Implement the thing described here in enough detail that an agent can do it
  without asking questions, and add tests for it.
scope:
  write: [src/thing.py, tests/test_thing.py]
verify: python3 -m unittest discover -s tests
max_tokens: 1000000
timeout_minutes: 20
%s`

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, name)), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func manifest(id, extra string) string {
	return strings.Replace(strings.Replace(good, "%s", id, 1), "%s", extra, 1)
}

func run(t *testing.T, files map[string]string) *Result {
	t.Helper()
	dir := t.TempDir()
	for n, b := range files {
		write(t, dir, n, b)
	}
	res, err := Dir(filepath.Join(dir, "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	return res
}

func find(res *Result, sev Severity, substr string) bool {
	for _, f := range res.Findings {
		if f.Severity == sev && strings.Contains(f.Msg, substr) {
			return true
		}
	}
	return false
}

func TestCleanProjectHasNoFindings(t *testing.T) {
	res, err := Dir(filepath.Join("..", "..", "..", "examples", "hello-project", "tasks"))
	if err != nil {
		t.Fatal(err)
	}
	if len(res.Findings) != 0 || res.HasErrors(true) {
		t.Fatalf("hello-project should be clean: %v", res.Findings)
	}
	if len(res.Valid) != 3 {
		t.Fatalf("valid manifests: %d", len(res.Valid))
	}
}

func TestFindings(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		sev   Severity
		want  string
	}{
		{"schema error", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "max_tokens: 1000000", "max_tokens: 5", 1)}, Error, "manifest.schema.json"},
		{"id mismatch", map[string]string{"tasks/0001-a.yaml": manifest("0002-b", "")}, Error, "does not match file name"},
		{"bad file name", map[string]string{"tasks/first.yaml": manifest("0001-a", "")}, Error, "not a valid manifest path"},
		{"yml extension", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", ""), "tasks/0002-b.yml": manifest("0002-b", "")}, Error, ".yml"},
		{"anchors", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "title: A task", "title: &x A task", 1)}, Error, "anchors"},
		{"unknown dependency", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0009-missing]\n")}, Error, "unknown task"},
		{"self dependency", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0001-a]\n")}, Error, "depends on itself"},
		{"dependency cycle", map[string]string{
			"tasks/0001-a.yaml": manifest("0001-a", "depends_on: [0002-b]\n"),
			"tasks/0002-b.yaml": manifest("0002-b", "depends_on: [0003-c]\n"),
			"tasks/0003-c.yaml": manifest("0003-c", "depends_on: [0001-a]\n")}, Error, "cycle"},
		{"never-writable scope: workflows", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "[src/thing.py, tests/test_thing.py]", "[\".github/workflows/ci.yml\"]", 1)}, Error, "never-writable"},
		{"never-writable scope: tasks", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "[src/thing.py, tests/test_thing.py]", "[\"tasks/**\", src/a.py]", 1)}, Error, "never-writable"},
		{"never-writable scope: descriptor", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "[src/thing.py, tests/test_thing.py]", "[agentfund.yaml]", 1)}, Error, "never-writable"},
		{"scope **", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "[src/thing.py, tests/test_thing.py]", "[\"**\"]", 1)}, Warning, "too broad"},
		{"scope * at root", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "[src/thing.py, tests/test_thing.py]", "[\"*\"]", 1)}, Warning, "too broad"},
		{"verify true", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "verify: python3 -m unittest discover -s tests", "verify: \"true\"", 1)}, Warning, "trivially true"},
		{"verify exit 0", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "verify: python3 -m unittest discover -s tests", "verify: exit 0", 1)}, Warning, "trivially true"},
		{"verify || true", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "verify: python3 -m unittest discover -s tests", "verify: make test || true", 1)}, Warning, "trivially true"},
		{"short prompt", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "prompt: |\n  Implement the thing described here in enough detail that an agent can do it\n  without asking questions, and add tests for it.\n", "prompt: Fix it.\n", 1)}, Warning, "prompt is only"},
		{"max_tokens above new-project cap", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "max_tokens: 1000000", "max_tokens: 5000001", 1)}, Warning, "new projects"},
		{"missing timeout", map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "timeout_minutes: 20\n", "", 1)}, Warning, "timeout_minutes is not set"},
		{"bad descriptor", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", ""), "agentfund.yaml": "spec_version: 1\nname: x\n"}, Error, "agentfund.schema.json"},
		{"descriptor key not a key", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", ""),
			"agentfund.yaml": "spec_version: 1\nname: x\ndescription: d\nrepo_url: https://github.com/a/b\nci_provider: github\npubkey: " + strings.Repeat("A", 56) + "\n"}, Error, "pubkey"},
		{"token goal below sum", map[string]string{"tasks/0001-a.yaml": manifest("0001-a", ""),
			"agentfund.yaml": "spec_version: 1\nname: x\ndescription: d\nrepo_url: https://github.com/a/b\nci_provider: github\npubkey: RWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\ntoken_goal: 5\n"}, Warning, "token_goal"},
		{"no manifests", map[string]string{"tasks/README.md": "x"}, Error, "no manifests"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := run(t, c.files)
			if !find(res, c.sev, c.want) {
				t.Fatalf("no %s containing %q in %v", c.sev, c.want, res.Findings)
			}
			if c.sev == Error && !res.HasErrors(false) {
				t.Fatal("HasErrors(false) should be true")
			}
			if c.sev == Warning && (res.HasErrors(false) || !res.HasErrors(true)) {
				t.Fatalf("a warning must fail only in strict mode: %v", res.Findings)
			}
		})
	}
	// Boundaries that must NOT warn.
	ok := run(t, map[string]string{"tasks/0001-a.yaml": strings.Replace(manifest("0001-a", ""), "max_tokens: 1000000", "max_tokens: 5000000", 1)})
	if len(ok.Findings) != 0 {
		t.Fatalf("5,000,000 is at the cap, not above: %v", ok.Findings)
	}
}

func TestTriviallyTrue(t *testing.T) {
	for _, c := range []string{"", " ", "true", ":", "exit 0", "exit", "/bin/true", "echo ok", "echo", "sh -c true", "sh -c 'exit 0'", "make test || true", "pytest; true", "true;", "test 1"} {
		if !TriviallyTrue(c) {
			t.Errorf("%q should be flagged", c)
		}
	}
	for _, c := range []string{"make test", "python3 -m unittest", "cargo test", "test -f out.txt", "exit 1", "true && make test", "echo x && make test", "npm test", "grep -q true file"} {
		if TriviallyTrue(c) {
			t.Errorf("%q should not be flagged", c)
		}
	}
}
