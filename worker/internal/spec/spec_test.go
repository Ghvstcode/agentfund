package spec

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The embedded schemas must be byte-identical to the normative copies.
func TestEmbeddedSchemasMatchSpec(t *testing.T) {
	for _, n := range []string{SchemaManifest, SchemaDescriptor, SchemaLock} {
		want, err := os.ReadFile(filepath.Join("..", "..", "..", "spec", "schemas", n))
		if err != nil {
			t.Fatalf("read normative schema: %v", err)
		}
		got, err := SchemaBytes(n)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s: embedded copy differs from spec/schemas — run `make sync-spec` (go generate ./internal/spec)", n)
		}
	}
}

func TestParseYAMLCoreSchema(t *testing.T) {
	got, err := ParseYAML([]byte(`
s: hello
n: 12
neg: -3
oct: 0o17
hex: 0x1F
legacy_octal: 0123
f: 1.5
t: true
no: no
on: on
nul: ~
empty:
date: 2001-01-01
q: "12"
list: [a, 1, null]
block: |
  line
`))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"s": "hello", "n": json.Number("12"), "neg": json.Number("-3"), "oct": json.Number("15"),
		"hex": json.Number("31"), "legacy_octal": json.Number("123"), "f": 1.5, "t": true,
		"no": "no", "on": "on", "nul": nil, "empty": nil, "date": "2001-01-01", "q": "12",
		"list": []any{"a", json.Number("1"), nil}, "block": "line\n",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func TestParseYAMLRejects(t *testing.T) {
	cases := map[string]string{
		"anchor":            "a: &x 1\nb: 2\n",
		"alias":             "a: &x 1\nb: *x\n",
		"anchor on map":     "a: &x {b: 1}\n",
		"merge key":         "a: {b: 1}\nc:\n  <<: {d: 1}\n",
		"explicit str tag":  "a: !!str 1\n",
		"explicit int tag":  "a: !!int \"1\"\n",
		"custom tag":        "a: !thing {b: 1}\n",
		"custom scalar tag": "a: !thing b\n",
		"tag on sequence":   "a: !!set [b]\n",
		"binary tag":        "a: !!binary aGk=\n",
		"multi doc":         "a: 1\n---\nb: 2\n",
		"multi doc empty":   "a: 1\n---\n",
		"empty":             "",
		"duplicate key":     "a: 1\na: 2\n",
		"complex key":       "? [a, b]\n: 1\n",
		"syntax":            "a: [1, 2\n",
		"tagged key":        "!!str a: 1\n",
		"anchored key":      "&k a: 1\n",
	}
	for name, doc := range cases {
		t.Run(name, func(t *testing.T) {
			if v, err := ParseYAML([]byte(doc)); err == nil {
				t.Fatalf("accepted: %#v", v)
			}
		})
	}
	if _, err := ParseYAML([]byte("a: \"<<\"\n\"<<\": 1\n")); err != nil {
		t.Fatalf("quoted << is an ordinary string: %v", err)
	}
	if _, err := ParseYAML(bytes.Repeat([]byte("a"), MaxYAMLBytes+1)); err == nil {
		t.Fatal("oversized document accepted")
	}
}

const goodManifest = `spec_version: 1
id: 0001-hello
title: Hello
prompt: Write hello.txt containing the word hello and nothing else, please.
scope:
  write: [hello.txt]
verify: test -f hello.txt
max_tokens: 100000
`

func TestParseManifest(t *testing.T) {
	m, err := ParseManifestAt("tasks/0001-hello.yaml", []byte(goodManifest))
	if err != nil {
		t.Fatal(err)
	}
	if m.TimeoutMinutes != 60 || m.BaseBranch != "main" || m.TimeoutSet || m.ReadSet || m.MaxTokens != 100000 {
		t.Fatalf("defaults not applied: %+v", m)
	}
	mut := func(old, new string) string {
		if !strings.Contains(goodManifest, old) {
			t.Fatalf("fixture lacks %q", old)
		}
		return strings.Replace(goodManifest, old, new, 1)
	}
	bad := map[string]struct{ path, doc string }{
		"id != filename":        {"tasks/0002-other.yaml", goodManifest},
		"bad path":              {"tasks/hello.yaml", goodManifest},
		"nested path":           {"tasks/sub/0001-hello.yaml", goodManifest},
		"unknown spec_version":  {"tasks/0001-hello.yaml", mut("spec_version: 1", "spec_version: 2")},
		"string spec_version":   {"tasks/0001-hello.yaml", mut("spec_version: 1", "spec_version: \"1\"")},
		"missing verify":        {"tasks/0001-hello.yaml", mut("verify: test -f hello.txt\n", "")},
		"unknown field":         {"tasks/0001-hello.yaml", goodManifest + "extra: 1\n"},
		"empty write":           {"tasks/0001-hello.yaml", mut("[hello.txt]", "[]")},
		"absolute glob":         {"tasks/0001-hello.yaml", mut("[hello.txt]", "[/etc/passwd]")},
		"dotdot glob":           {"tasks/0001-hello.yaml", mut("[hello.txt]", "[\"a/../../b\"]")},
		"git glob":              {"tasks/0001-hello.yaml", mut("[hello.txt]", "[\".git/config\"]")},
		"backslash glob":        {"tasks/0001-hello.yaml", mut("[hello.txt]", "['a\\b']")},
		"max_tokens too small":  {"tasks/0001-hello.yaml", mut("max_tokens: 100000", "max_tokens: 10")},
		"max_tokens float":      {"tasks/0001-hello.yaml", mut("max_tokens: 100000", "max_tokens: 1.5e5x")},
		"timeout zero":          {"tasks/0001-hello.yaml", goodManifest + "timeout_minutes: 0\n"},
		"bad dep id":            {"tasks/0001-hello.yaml", goodManifest + "depends_on: [nope]\n"},
		"anchors":               {"tasks/0001-hello.yaml", mut("title: Hello", "title: &t Hello")},
		"alias":                 {"tasks/0001-hello.yaml", mut("verify: test -f hello.txt", "verify: *nope")},
		"merge":                 {"tasks/0001-hello.yaml", mut("scope:\n", "scope:\n  <<: {read: [a]}\n")},
		"tagged":                {"tasks/0001-hello.yaml", mut("title: Hello", "title: !!str Hello")},
		"two documents":         {"tasks/0001-hello.yaml", goodManifest + "---\n" + goodManifest},
		"bad base_branch":       {"tasks/0001-hello.yaml", goodManifest + "base_branch: \"a b\"\n"},
		"duplicate prompt keys": {"tasks/0001-hello.yaml", goodManifest + "prompt: do something else entirely\n"},
	}
	for name, c := range bad {
		t.Run(name, func(t *testing.T) {
			if m, err := ParseManifestAt(c.path, []byte(c.doc)); err == nil {
				t.Fatalf("accepted: %+v", m)
			}
		})
	}
}

func TestExampleProjectValidates(t *testing.T) {
	root := filepath.Join("..", "..", "..", "examples", "hello-project")
	raw, err := os.ReadFile(filepath.Join(root, "agentfund.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseDescriptor(raw); err != nil {
		t.Fatalf("agentfund.yaml: %v", err)
	}
	files, _ := filepath.Glob(filepath.Join(root, "tasks", "*.yaml"))
	if len(files) != 3 {
		t.Fatalf("expected 3 manifests, found %d", len(files))
	}
	for _, f := range files {
		raw, _ := os.ReadFile(f)
		if _, err := ParseManifestAt("tasks/"+filepath.Base(f), raw); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
}

func TestGlobs(t *testing.T) {
	w := []string{"src/**", "docs/*.md", "README.md", "pkg/{a,b}/x.go", "**/*.gen"}
	yes := []string{"src/a.py", "src/deep/er/a.py", "docs/x.md", "README.md", "pkg/a/x.go", "pkg/b/x.go", "x.gen", "a/b/c.gen"}
	no := []string{"docs/sub/x.md", "readme.md", "pkg/c/x.go", "srcs/a.py", "Docs/x.md"}
	for _, p := range yes {
		if !Writable(w, p) {
			t.Errorf("%s should be writable", p)
		}
	}
	for _, p := range no {
		if Writable(w, p) {
			t.Errorf("%s should not be writable", p)
		}
	}
	all := []string{"**"}
	for _, p := range []string{"agentfund.yaml", "tasks/0001-a.yaml", "tasks/MANIFEST.lock", "tasks/x/y", ".github/workflows/ci.yml", ".github/x", ".git/config", ".git", "tasks", ".github"} {
		if Writable(all, p) {
			t.Errorf("%s must never be writable", p)
		}
	}
	for _, p := range []string{"sub/agentfund.yaml", "sub/tasks/x", "a/.github/x", "tasks.txt", ".githubx"} {
		if !Writable(all, p) {
			t.Errorf("%s is writable under **", p)
		}
	}
	for glob, want := range map[string]struct {
		dir  string
		wild bool
	}{
		"src/**": {"src", true}, "src/a.py": {"src", false}, "*.md": {"", true}, "a/b/c.txt": {"a/b", false},
		"a/b*/c": {"a", true}, "x": {"", false}, "a/{b,c}/d": {"a", true}, "**": {"", true},
	} {
		if d, w := LiteralPrefixDir(glob); d != want.dir || w != want.wild {
			t.Errorf("LiteralPrefixDir(%q) = %q,%v want %q,%v", glob, d, w, want.dir, want.wild)
		}
	}
}
