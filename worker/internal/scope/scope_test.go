package scope

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"sort"
	"strings"
	"testing"

	"github.com/ghvstcode/agentfund/worker/internal/gitx"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

var ctx = context.Background()

// repo is a synthetic baseline: path -> content ("->target" marks a symlink, "x:" prefix an executable).
type repo map[string]string

func (r repo) plan(t *testing.T, write []string, read ...string) (*Plan, map[string][]byte) {
	t.Helper()
	blobs := map[string][]byte{}
	var entries []gitx.TreeEntry
	for p, c := range r {
		e := gitx.TreeEntry{Path: p, Type: "blob", Mode: ModeFile}
		data := []byte(c)
		switch {
		case strings.HasPrefix(c, "->"):
			e.Mode, data = ModeSymlink, []byte(c[2:])
		case strings.HasPrefix(c, "x:"):
			e.Mode, data = ModeExec, []byte(c[2:])
		case c == "submodule":
			e.Mode, e.Type = ModeGitlink, "commit"
		}
		e.OID = blobOID(40, data)
		blobs[e.OID] = data
		entries = append(entries, e)
	}
	m := &spec.Manifest{Scope: spec.Scope{Write: write, Read: read}, ReadSet: read != nil}
	p, err := NewPlan(ctx, entries, m, func(_ context.Context, oid string) ([]byte, error) { return blobs[oid], nil })
	if err != nil {
		t.Fatal(err)
	}
	return p, blobs
}

type ent struct {
	name string
	typ  byte
	body string
	link string
	mode int64
}

func file(name, body string) ent { return ent{name: name, typ: tar.TypeReg, body: body, mode: 0o644} }
func exe(name, body string) ent  { return ent{name: name, typ: tar.TypeReg, body: body, mode: 0o755} }
func dir(name string) ent        { return ent{name: name + "/", typ: tar.TypeDir, mode: 0o755} }
func sym(name, to string) ent    { return ent{name: name, typ: tar.TypeSymlink, link: to, mode: 0o777} }

func mktar(t *testing.T, ents ...ent) io.Reader {
	t.Helper()
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tw.WriteHeader(&tar.Header{Name: "work/", Typeflag: tar.TypeDir, Mode: 0o755}); err != nil {
		t.Fatal(err)
	}
	for _, e := range ents {
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Mode: e.mode, Linkname: e.link, Size: int64(len(e.body)), Format: tar.FormatPAX}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		if !strings.HasPrefix(e.name, "RAW:") {
			h.Name = "work/" + e.name
		} else {
			h.Name = strings.TrimPrefix(e.name, "RAW:")
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatalf("header %q: %v", e.name, err)
		}
		if e.typ == tar.TypeReg {
			tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	return &buf
}

// unchanged renders the baseline as the sandbox would return it.
func unchanged(r repo, p *Plan) []ent {
	var out []ent
	for _, f := range p.Files {
		c := r[f.Path]
		switch f.Mode {
		case ModeSymlink:
			out = append(out, sym(f.Path, c[2:]))
		case ModeExec:
			out = append(out, exe(f.Path, c[2:]))
		default:
			out = append(out, file(f.Path, c))
		}
	}
	return out[:len(out):len(out)] // full slice: appends in table tests must not alias
}

func without(ents []ent, name string) []ent {
	var out []ent
	for _, e := range ents {
		if e.name != name {
			out = append(out, e)
		}
	}
	return out
}

func replace(ents []ent, e ent) []ent { return append(without(ents, e.name), e) }

var base = repo{
	"README.md":                "# hi\n",
	"src/__init__.py":          "",
	"src/textutil.py":          "def a(): pass\n",
	"src/deep/mod.py":          "x = 1\n",
	"tests/__init__.py":        "",
	"scripts/run.sh":           "x:#!/bin/sh\n",
	"docs/link":                "->../README.md",
	".gitignore":               "__pycache__/\n*.pyc\nbuild/\n",
	".github/workflows/ci.yml": "name: ci\n",
	"agentfund.yaml":           "spec_version: 1\n",
	"tasks/0001-a.yaml":        "id: 0001-a\n",
	"tasks/MANIFEST.lock":      "{}\n",
	"vendor/lib":               "submodule",
	"big.bin":                  strings.Repeat("B", 4096),
}

// fakeIgnore mimics the fixture's .gitignore.
func fakeIgnore(paths []string) (map[string]bool, error) {
	out := map[string]bool{}
	for _, p := range paths {
		if strings.Contains("/"+p, "/__pycache__/") || strings.HasSuffix(p, ".pyc") || strings.HasPrefix(p, "build/") || strings.Contains(p, "/build/") {
			out[p] = true
		}
	}
	return out, nil
}

func TestPlanFiltering(t *testing.T) {
	p, _ := base.plan(t, []string{"src/textutil.py", "tests/test_x.py"})
	for _, gone := range []string{"agentfund.yaml", "tasks/0001-a.yaml", "tasks/MANIFEST.lock", "vendor/lib"} {
		if _, ok := p.Lookup(gone); ok {
			t.Errorf("%s must not be materialised", gone)
		}
	}
	for _, kept := range []string{"README.md", "src/textutil.py", ".github/workflows/ci.yml", "docs/link", "big.bin"} {
		if _, ok := p.Lookup(kept); !ok {
			t.Errorf("%s should be materialised when scope.read is unset", kept)
		}
	}
	if p.Dropped != 4 {
		t.Errorf("dropped %d, want 4", p.Dropped)
	}

	// With scope.read only read ∪ write survive.
	p, _ = base.plan(t, []string{"src/textutil.py", "tests/test_x.py"}, "src/**", "README.md")
	var got []string
	for _, f := range p.Files {
		got = append(got, f.Path)
	}
	want := []string{"README.md", "src/__init__.py", "src/deep/mod.py", "src/textutil.py"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("with scope.read: %v, want %v", got, want)
	}
	// An empty read list means "only the write scope", not "whole repo".
	p, _ = base.plan(t, []string{"src/textutil.py"}, []string{}...)
	p2, _ := repo(base).plan(t, []string{"src/textutil.py"})
	if len(p2.Files) < 5 {
		t.Fatalf("unset read should keep the repo, got %d files", len(p2.Files))
	}
	m := &spec.Manifest{Scope: spec.Scope{Write: []string{"src/textutil.py"}, Read: []string{}}, ReadSet: true}
	p3, err := NewPlan(ctx, []gitx.TreeEntry{{Path: "src/textutil.py", Type: "blob", Mode: ModeFile, OID: "a"}, {Path: "README.md", Type: "blob", Mode: ModeFile, OID: "b"}}, m, nil)
	if err != nil || len(p3.Files) != 1 || p3.Files[0].Path != "src/textutil.py" {
		t.Fatalf("empty read list: %+v %v", p3, err)
	}
	_ = p

	// Hostile tree paths are refused outright.
	for _, bad := range []string{"../x", "a/../b", "/abs", "a//b", ".git/config", "a/.GIT/hooks/x", "a/.git ./x", "a\\b", "x/git~1/y", ""} {
		if _, err := NewPlan(ctx, []gitx.TreeEntry{{Path: bad, Type: "blob", Mode: ModeFile, OID: "a"}}, &spec.Manifest{Scope: spec.Scope{Write: []string{"**"}}}, nil); err == nil {
			t.Errorf("tree path %q accepted", bad)
		}
	}
}

func TestWriteTarOwnershipAndModes(t *testing.T) {
	p, blobs := base.plan(t, []string{"src/textutil.py", "tests/test_x.py", "gen/**", "scripts/*.sh", ".github/workflows/new.yml"})
	var buf bytes.Buffer
	if err := p.WriteTar(ctx, &buf, func(_ context.Context, oid string) ([]byte, error) { return blobs[oid], nil }); err != nil {
		t.Fatal(err)
	}
	type meta struct {
		uid  int
		mode int64
		typ  byte
		link string
		body string
	}
	got := map[string]meta{}
	tr := tar.NewReader(&buf)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		if strings.HasPrefix(h.Name, "/") || strings.Contains(h.Name, "..") {
			t.Fatalf("bad name %q", h.Name)
		}
		got[h.Name] = meta{h.Uid, h.Mode, h.Typeflag, h.Linkname, string(b)}
	}
	check := func(name string, uid int, mode int64, typ byte) {
		t.Helper()
		m, ok := got[name]
		if !ok {
			t.Errorf("%s missing from tar", name)
			return
		}
		if m.uid != uid || m.mode != mode || m.typ != typ {
			t.Errorf("%s: uid=%d mode=%o type=%q, want uid=%d mode=%o type=%q", name, m.uid, m.mode, m.typ, uid, mode, typ)
		}
	}
	check("src/textutil.py", AgentUID, 0o644, tar.TypeReg) // in write scope: agent-owned
	check("src/__init__.py", 0, 0o644, tar.TypeReg)        // read-only
	check("README.md", 0, 0o644, tar.TypeReg)
	check("scripts/run.sh", AgentUID, 0o755, tar.TypeReg)    // matches scripts/*.sh, keeps exec bit
	check(".github/workflows/ci.yml", 0, 0o644, tar.TypeReg) // never writable
	check("docs/link", 0, 0o777, tar.TypeSymlink)
	check("src/", 0, 0o1777, tar.TypeDir)   // parent of a literal write path
	check("tests/", 0, 0o1777, tar.TypeDir) // parent of a not-yet-existing write path
	check("gen/", 0, 0o1777, tar.TypeDir)   // literal prefix of a glob, created
	check("scripts/", 0, 0o1777, tar.TypeDir)
	check("src/deep/", 0, 0o755, tar.TypeDir) // not addressed by any write glob
	check("docs/", 0, 0o755, tar.TypeDir)
	check(".github/", 0, 0o755, tar.TypeDir) // never writable even though a glob names it
	check(".github/workflows/", 0, 0o755, tar.TypeDir)
	if got["src/textutil.py"].body != "def a(): pass\n" || got["docs/link"].link != "../README.md" {
		t.Errorf("content or link target wrong: %+v", got["src/textutil.py"])
	}
	for name := range got {
		if strings.HasPrefix(name, "tasks") || name == "agentfund.yaml" || strings.HasPrefix(name, "vendor") {
			t.Errorf("%s must not be in the sandbox", name)
		}
	}
	if p.RootWritable() {
		t.Error("root must not be writable for these globs")
	}

	// A recursive glob makes existing sub-directories writable; never-writable ones stay closed.
	p, _ = base.plan(t, []string{"**"})
	w := p.WritableDirs()
	for _, d := range []string{"", "src", "src/deep", "docs", "scripts", "tests"} {
		if !w[d] {
			t.Errorf("dir %q should be writable under **", d)
		}
	}
	for _, d := range []string{".github", ".github/workflows", "tasks"} {
		if w[d] {
			t.Errorf("dir %q must never be writable", d)
		}
	}
	p, _ = base.plan(t, []string{"*.md"})
	if !p.RootWritable() || len(p.WritableDirs()) != 1 {
		t.Errorf("*.md: root writable only, got %v", p.WritableDirs())
	}
	p, _ = base.plan(t, []string{"src/*/gen_*.py", "**/*.snap"})
	w = p.WritableDirs()
	if !w["src/deep"] || !w["src"] || !w[""] || !w["docs"] || w[".github"] {
		t.Errorf("mid-pattern globs: %v", w)
	}
}

func TestDiff(t *testing.T) {
	write := []string{"src/textutil.py", "tests/test_slugify.py", "gen/**", "scripts/*.sh", "docs/**"}
	plan, _ := base.plan(t, write)
	same := unchanged(base, plan)
	small := Limits{MaxFileBytes: 1000, MaxTotalBytes: 2500, MaxEntries: 60}

	type want struct {
		violation string // substring of the violation; "" = accepted
		changes   string // "K path,K path" when accepted
	}
	cases := []struct {
		name string
		ents []ent
		lim  Limits
		want want
	}{
		{"nothing changed", same, small, want{changes: ""}},
		{"modify in scope", replace(same, file("src/textutil.py", "new\n")), small, want{changes: "modified src/textutil.py"}},
		{"add in scope", append(same, file("tests/test_slugify.py", "t\n")), small, want{changes: "added tests/test_slugify.py"}},
		{"add under recursive glob with new dirs", append(same, dir("gen/a"), dir("gen/a/b"), file("gen/a/b/c.txt", "c")), small, want{changes: "added gen/a/b/c.txt"}},
		{"delete in scope", without(same, "src/textutil.py"), small, want{changes: "deleted src/textutil.py"}},
		{"chmod +x in scope", replace(same, exe("src/textutil.py", "def a(): pass\n")), small, want{changes: "mode src/textutil.py"}},
		{"chmod -x in scope", replace(same, file("scripts/run.sh", "#!/bin/sh\n")), small, want{changes: "mode scripts/run.sh"}},
		{"add, modify and delete together", append(without(replace(same, file("src/textutil.py", "v2")), "scripts/run.sh"), file("gen/x", "1")), small,
			want{changes: "added gen/x,deleted scripts/run.sh,modified src/textutil.py"}},
		{"empty new file", append(same, file("gen/empty", "")), small, want{changes: "added gen/empty"}},
		{"new empty directory is not a change", append(same, dir("gen/emptydir"), dir("somewhere")), small, want{changes: ""}},

		// Outside scope.
		{"modify outside scope", replace(same, file("README.md", "pwned")), small, want{violation: "outside scope.write was modified"}},
		{"modify sibling of scoped file", replace(same, file("src/__init__.py", "x")), small, want{violation: "outside scope.write was modified"}},
		{"add outside scope", append(same, file("src/other.py", "x")), small, want{violation: "outside scope.write was created"}},
		{"add at root", append(same, file("pwned.txt", "x")), small, want{violation: "outside scope.write was created"}},
		{"delete outside scope", without(same, "README.md"), small, want{violation: "outside scope.write was deleted"}},
		{"chmod outside scope", replace(same, exe("README.md", "# hi\n")), small, want{violation: "mode of a file outside"}},
		{"rename = delete + add, target outside", append(without(same, "src/textutil.py"), file("src/renamed.py", "def a(): pass\n")), small, want{violation: "src/renamed.py"}},
		{"rename = delete + add, source outside", append(without(same, "src/__init__.py"), file("gen/moved.py", "")), small, want{violation: "src/__init__.py"}},
		{"one good change does not excuse a bad one", append(replace(same, file("src/textutil.py", "ok")), file("x", "bad")), small, want{violation: "\"x\""}},

		// Never-writable, even though docs/** style globs could never match and "**" would.
		{"add workflow", append(same, file(".github/workflows/evil.yml", "x")), small, want{violation: "never-writable"}},
		{"modify workflow", replace(same, file(".github/workflows/ci.yml", "x")), small, want{violation: "never-writable"}},
		{"delete workflow", without(same, ".github/workflows/ci.yml"), small, want{violation: "never-writable path was deleted"}},
		{"recreate agentfund.yaml", append(same, file("agentfund.yaml", "pubkey: evil")), small, want{violation: "never-writable"}},
		{"add a manifest", append(same, file("tasks/0009-evil.yaml", "x")), small, want{violation: "never-writable"}},
		{"add tasks dir file", append(same, file("tasks/MANIFEST.lock", "{}")), small, want{violation: "never-writable"}},
		{"add .git", append(same, file(".git/config", "x")), small, want{violation: ".git"}},
		{"add .git hook", append(same, exe(".git/hooks/pre-commit", "x")), small, want{violation: ".git"}},
		{"add nested .git", append(same, file("gen/.git/config", "x")), small, want{violation: ".git"}},
		{"add .GIT (case-insensitive hosts)", append(same, file("gen/.GIT/config", "x")), small, want{violation: ".git"}},
		{"add '.git ' (NTFS alias)", append(same, file("gen/.git /config", "x")), small, want{violation: ".git"}},
		{"add git~1 (8.3 alias)", append(same, file("gen/GIT~1/config", "x")), small, want{violation: ".git"}},
		{"add .git with zero-width joiner (HFS alias)", append(same, file("gen/.g‌it/config", "x")), small, want{violation: ".git"}},

		// Non-regular files.
		{"new symlink in scope", append(same, sym("gen/link", "/etc/passwd")), small, want{violation: "symlinks"}},
		{"new symlink out of scope", append(same, sym("evil", "../../etc")), small, want{violation: "symlinks"}},
		{"scoped file replaced by symlink", replace(same, sym("src/textutil.py", "/etc/shadow")), small, want{violation: "symlinks"}},
		{"tracked symlink retargeted", replace(same, sym("docs/link", "/etc/passwd")), small, want{violation: "symlinks"}},
		{"tracked symlink replaced by file", replace(same, file("docs/link", "data")), small, want{violation: "tracked symlink was replaced"}},
		{"tracked symlink deleted in scope", without(same, "docs/link"), small, want{changes: "deleted docs/link"}},
		{"hard link", append(same, ent{name: "gen/hl", typ: tar.TypeLink, link: "work/README.md"}), small, want{violation: "non-regular"}},
		{"char device", append(same, ent{name: "gen/null", typ: tar.TypeChar}), small, want{violation: "non-regular"}},
		{"block device", append(same, ent{name: "gen/sda", typ: tar.TypeBlock}), small, want{violation: "non-regular"}},
		{"fifo", append(same, ent{name: "gen/pipe", typ: tar.TypeFifo}), small, want{violation: "non-regular"}},
		{"scoped file replaced by directory with out-of-scope content", append(without(same, "src/textutil.py"), dir("src/textutil.py"), file("src/textutil.py/x", "1")), small, want{violation: "src/textutil.py/x"}},

		// Hostile names.
		{"dotdot", append(same, ent{name: "RAW:work/../etc/passwd", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "work/../etc/passwd"}},
		{"dotdot inside", append(same, ent{name: "RAW:work/gen/../../x", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "work/gen/../../x"}},
		{"absolute", append(same, ent{name: "RAW:/etc/passwd", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "outside the working tree"}},
		{"other root", append(same, ent{name: "RAW:home/agent/x", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "outside the working tree"}},
		{"prefix lookalike", append(same, ent{name: "RAW:workx/gen/a", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "outside the working tree"}},
		{"double slash", append(same, ent{name: "RAW:work/gen//a", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "not clean"}},
		{"dot segment", append(same, ent{name: "RAW:work/gen/./a", typ: tar.TypeReg, body: "x", mode: 0o644}), small, want{violation: "not clean"}},
		{"backslash", append(same, file("gen/a\\..\\b", "x")), small, want{violation: "backslash"}},
		{"duplicate entry", append(same, file("gen/a", "1"), file("gen/a", "2")), small, want{violation: "duplicate"}},
		{"duplicate of tracked file", append(same, file("README.md", "# hi\n")), small, want{violation: "duplicate"}},

		// Sizes.
		{"file at the size limit", append(same, file("gen/ok", strings.Repeat("a", 1000))), small, want{changes: "added gen/ok"}},
		{"file over the size limit", append(same, file("gen/big", strings.Repeat("a", 1001))), small, want{violation: "exceeds the size limits"}},
		{"modified file over the size limit", replace(same, file("src/textutil.py", strings.Repeat("a", 1001))), small, want{violation: "larger than"}},
		{"total at the limit", append(same, file("gen/1", strings.Repeat("a", 1000)), file("gen/2", strings.Repeat("a", 1000)), file("gen/3", strings.Repeat("a", 500))), small,
			want{changes: "added gen/1,added gen/2,added gen/3"}},
		{"total over the limit", append(same, file("gen/1", strings.Repeat("a", 1000)), file("gen/2", strings.Repeat("a", 1000)), file("gen/3", strings.Repeat("a", 501))), small,
			want{violation: "exceeds the size limits"}},
		{"too many entries", append(same, manyFiles(60)...), small, want{violation: "entries"}},
		{"untouched large tracked file is fine", same, Limits{MaxFileBytes: 100, MaxTotalBytes: 1000, MaxEntries: 60}, want{changes: ""}},
		{"touched large tracked file out of scope", replace(same, file("big.bin", strings.Repeat("C", 4096))), Limits{MaxFileBytes: 100, MaxTotalBytes: 1000, MaxEntries: 60}, want{violation: "outside scope.write was modified"}},

		// .gitignore handling.
		{"ignored build output outside scope is skipped", append(same, dir("src/__pycache__"), file("src/__pycache__/textutil.cpython-312.pyc", "\x00\x01"), file("build/out.o", "o")), small, want{changes: ""}},
		{"ignored file inside scope is not published", append(same, file("gen/__pycache__/x.pyc", "x"), file("gen/keep.txt", "k")), small, want{changes: "added gen/keep.txt"}},
		{"huge ignored file is skipped", append(same, file("build/huge.bin", strings.Repeat("z", 5000))), small, want{changes: ""}},
		{"ignored name under never-writable is still refused", append(same, file(".github/__pycache__/x.pyc", "x")), small, want{violation: "never-writable"}},
		{"tracked file matching ignore pattern still counts when modified", replace(same, file("README.md", "x")), small, want{violation: "README.md"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			changes, err := Diff(mktar(t, c.ents...), "work", plan, fakeIgnore, c.lim)
			if c.want.violation != "" {
				if !IsViolation(err) {
					t.Fatalf("want violation containing %q, got changes=%v err=%v", c.want.violation, changes, err)
				}
				if !strings.Contains(err.Error(), c.want.violation) {
					t.Fatalf("violation %q does not mention %q", err, c.want.violation)
				}
				if changes != nil {
					t.Fatal("a violation must not return a partial change set")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			var got []string
			for _, ch := range changes {
				got = append(got, string(ch.Kind)+" "+ch.Path)
				if ch.Kind != Deleted && ch.Mode != ModeFile && ch.Mode != ModeExec {
					t.Errorf("%s: bad mode %q", ch.Path, ch.Mode)
				}
				if ch.Kind == Deleted && ch.Content != nil {
					t.Errorf("%s: deletion carries content", ch.Path)
				}
			}
			sort.Strings(got)
			if strings.Join(got, ",") != c.want.changes {
				t.Fatalf("changes = %v, want %q", got, c.want.changes)
			}
		})
	}
}

func manyFiles(n int) []ent {
	var out []ent
	for i := 0; i < n; i++ {
		out = append(out, file("gen/f"+strings.Repeat("x", i), "1"))
	}
	return out
}

func TestDiffEdgeCases(t *testing.T) {
	plan, _ := base.plan(t, []string{"**"})
	same := unchanged(base, plan)

	// "**" still cannot touch never-writable paths.
	for _, e := range []ent{file(".github/workflows/x.yml", "x"), file("agentfund.yaml", "x"), file("tasks/0001-a.yaml", "x")} {
		if _, err := Diff(mktar(t, append(same, e)...), "work", plan, fakeIgnore, DefaultLimits); !IsViolation(err) {
			t.Errorf("%s under **: %v", e.name, err)
		}
	}
	// ... but everything else is allowed.
	ch, err := Diff(mktar(t, append(same, file("anything/at/all.txt", "x"))...), "work", plan, fakeIgnore, DefaultLimits)
	if err != nil || len(ch) != 1 {
		t.Fatalf("** add: %v %v", ch, err)
	}

	// Content is returned exactly, with the executable bit.
	ch, err = Diff(mktar(t, append(same, exe("bin/tool", "#!/bin/sh\necho hi\n"))...), "work", plan, fakeIgnore, DefaultLimits)
	if err != nil || len(ch) != 1 || string(ch[0].Content) != "#!/bin/sh\necho hi\n" || ch[0].Mode != ModeExec {
		t.Fatalf("content/mode: %+v %v", ch, err)
	}
	// setuid bits never survive: only 644/755 exist in a change.
	ch, _ = Diff(mktar(t, append(same, ent{name: "bin/suid", typ: tar.TypeReg, body: "x", mode: 0o4755})...), "work", plan, fakeIgnore, DefaultLimits)
	if len(ch) != 1 || ch[0].Mode != ModeExec {
		t.Fatalf("setuid file: %+v", ch)
	}

	// Garbage and truncated archives are violations, never panics or partial results.
	if _, err := Diff(strings.NewReader("this is not a tar archive at all, not even close........"+strings.Repeat("\x00", 600)), "work", plan, fakeIgnore, DefaultLimits); !IsViolation(err) {
		t.Errorf("garbage archive: %v", err)
	}
	var buf bytes.Buffer
	io.Copy(&buf, mktar(t, append(same, file("x.txt", strings.Repeat("a", 3000)))...))
	trunc := buf.Bytes()[:buf.Len()-2600]
	if _, err := Diff(bytes.NewReader(trunc), "work", plan, fakeIgnore, DefaultLimits); !IsViolation(err) {
		t.Errorf("truncated archive: %v", err)
	}
	// An empty archive means everything was deleted.
	ch, err = Diff(mktar(t), "work", plan, fakeIgnore, DefaultLimits)
	if !IsViolation(err) { // .github is never deletable
		t.Errorf("empty archive: %v %v", ch, err)
	}
	// An ignore-oracle failure is an error, not an approval.
	failing := func([]string) (map[string]bool, error) { return nil, io.ErrUnexpectedEOF }
	if ch, err := Diff(mktar(t, append(same, file("new.txt", "x"))...), "work", plan, failing, DefaultLimits); err == nil {
		t.Errorf("oracle failure accepted: %v", ch)
	}
	// With no oracle nothing is ignored.
	plan2, _ := base.plan(t, []string{"src/textutil.py"})
	if _, err := Diff(mktar(t, append(unchanged(base, plan2), file("build/out.o", "o"))...), "work", plan2, nil, DefaultLimits); !IsViolation(err) {
		t.Errorf("without an oracle an out-of-scope file must be a violation: %v", err)
	}

	// Files dropped at materialisation (scope.read) are not deletions; recreating them is an addition outside scope.
	plan3, _ := base.plan(t, []string{"src/textutil.py"}, "src/**")
	same3 := unchanged(base, plan3)
	if ch, err := Diff(mktar(t, same3...), "work", plan3, fakeIgnore, DefaultLimits); err != nil || len(ch) != 0 {
		t.Fatalf("filtered files reported as changes: %v %v", ch, err)
	}
	if _, err := Diff(mktar(t, append(same3, file("README.md", "# hi\n"))...), "work", plan3, fakeIgnore, DefaultLimits); !IsViolation(err) {
		t.Errorf("recreating a filtered-out file must be a violation: %v", err)
	}
}

func TestCheckPath(t *testing.T) {
	for _, ok := range []string{"a", "a/b.txt", ".gitignore", ".github/x", "a/.gitattributes", "git/x", "a b/c", "ünï/çødé", ".gitx/y"} {
		if err := CheckPath(ok); err != nil {
			t.Errorf("CheckPath(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "/a", "a/", "./a", "a/./b", "a/../b", "..", "a//b", "a\x00b", "a\\b", ".git", ".git/x", "a/.git/x", ".GiT/x", ".git./x", ".git /x", "GIT~1/x", "a/.git‍/x", strings.Repeat("a", 5000)} {
		if err := CheckPath(bad); err == nil {
			t.Errorf("CheckPath(%q) accepted", bad)
		}
	}
}
