package gitx_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/testutil"
)

var ctx = context.Background()

func TestCheckRepoURL(t *testing.T) {
	for _, ok := range []string{"https://github.com/a/b", "https://github.com/a/b.git", "https://git.example:8443/x/y", "file:///tmp/repo", "file://localhost/tmp/repo"} {
		if err := gitx.CheckRepoURL(ok); err != nil {
			t.Errorf("%s: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "--upload-pack=touch /tmp/pwn", "-oProxyCommand=x", "ssh://git@github.com/a/b", "git@github.com:a/b.git", "ext::sh -c id", "http://github.com/a/b",
		"https://user:pass@github.com/a/b", "https://token@github.com/a/b", "file://evil.example/share", "/tmp/repo", "https://", "git://github.com/a/b", "https://github.com/a/b\n--foo"} {
		if err := gitx.CheckRepoURL(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestFetchIgnoreAndCommit(t *testing.T) {
	src := testutil.NewRepo(t)
	src.Write(".gitignore", []byte("__pycache__/\n*.pyc\n/build/\n!keep.pyc\n"))
	src.Write("src/.gitignore", []byte("local.cfg\n"))
	src.Write("src/a.py", []byte("a = 1\n"))
	src.Write("README.md", []byte("# r\n"))
	// A hook in the source repo must never run in the cache.
	hook := filepath.Join(src.Dir, ".git", "hooks", "post-checkout")
	os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+filepath.Join(src.Dir, "HOOK_RAN")+"\n"), 0o755)
	c1 := src.Commit("one")

	cache := gitx.CachePath(t.TempDir(), "file://"+src.Dir)
	if err := gitx.Fetch(ctx, cache, "file://"+src.Dir, c1); err != nil {
		t.Fatal(err)
	}
	if !gitx.CommitExists(ctx, cache, c1) {
		t.Fatal("commit not fetched")
	}
	if head, err := gitx.ResolveBranch(ctx, cache, "main"); err != nil || head != c1 {
		t.Fatalf("resolve main: %s %v", head, err)
	}
	for _, bad := range []string{"-x", "a..b", "main^{tree}", "main; id"} {
		if _, err := gitx.ResolveBranch(ctx, cache, bad); err == nil {
			t.Errorf("ResolveBranch(%q) accepted", bad)
		}
	}

	ic, err := gitx.NewIgnoreChecker(ctx, cache, c1)
	if err != nil {
		t.Fatal(err)
	}
	defer ic.Close()
	got, err := ic.Ignored(ctx, []string{
		"src/__pycache__/a.cpython-312.pyc", "x.pyc", "keep.pyc", "build/out.o", "src/build/out.o", "src/local.cfg",
		"local.cfg", "src/new.py", "README.md", "deep/er/__pycache__/z", "weird name\nwith newline.pyc",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"src/__pycache__/a.cpython-312.pyc": true, "x.pyc": true, "build/out.o": true, "src/local.cfg": true,
		"deep/er/__pycache__/z": true, "weird name\nwith newline.pyc": true}
	for p := range want {
		if !got[p] {
			t.Errorf("%q should be ignored", p)
		}
	}
	for p := range got {
		if !want[p] {
			t.Errorf("%q should not be ignored", p)
		}
	}
	if none, err := ic.Ignored(ctx, []string{"src/new.py"}); err != nil || len(none) != 0 {
		t.Fatalf("nothing ignored: %v %v", none, err)
	}

	// Build a commit with plumbing only.
	sha, err := gitx.BuildCommit(ctx, cache, gitx.CommitSpec{
		Parent: c1, Message: "task: change\n\nAgentFund-Task: x\n", AuthorName: "W", AuthorEmail: "w@example.invalid",
		Changes: []gitx.TreeChange{
			{Path: "src/a.py", Mode: "100644", Content: []byte("a = 2\n")},
			{Path: "bin/tool", Mode: "100755", Content: []byte("#!/bin/sh\n")},
			{Path: "README.md", Delete: true},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	entries, _ := gitx.LsTree(ctx, cache, sha, "", true)
	seen := map[string]string{}
	for _, e := range entries {
		seen[e.Path] = e.Mode
	}
	if seen["src/a.py"] != "100644" || seen["bin/tool"] != "100755" || seen["README.md"] != "" || seen[".gitignore"] != "100644" {
		t.Fatalf("tree after commit: %v", seen)
	}
	if anc, _ := gitx.IsAncestor(ctx, cache, c1, sha); !anc {
		t.Fatal("new commit is not a child of the parent")
	}
	msg, _ := gitx.Run(ctx, cache, "log", "-1", "--format=%an <%ae>%n%B", sha)
	if !strings.Contains(string(msg), "W <w@example.invalid>") || !strings.Contains(string(msg), "AgentFund-Task: x") {
		t.Fatalf("commit metadata: %s", msg)
	}

	// git refuses paths that alias .git or escape the tree.
	for _, bad := range []string{".git/config", ".GIT/config", "a/.git/hooks/x", "../escape", "/abs", "a/../b"} {
		_, err := gitx.BuildCommit(ctx, cache, gitx.CommitSpec{Parent: c1, Message: "m", AuthorName: "W", AuthorEmail: "w@x.invalid",
			Changes: []gitx.TreeChange{{Path: bad, Mode: "100644", Content: []byte("x")}}})
		if err == nil {
			t.Errorf("BuildCommit accepted path %q", bad)
		}
	}
	// No-op change sets are reported as such.
	_, err = gitx.BuildCommit(ctx, cache, gitx.CommitSpec{Parent: c1, Message: "m", AuthorName: "W", AuthorEmail: "w@x.invalid",
		Changes: []gitx.TreeChange{{Path: "src/a.py", Mode: "100644", Content: []byte("a = 1\n")}}})
	if !errors.Is(err, gitx.ErrNoChanges) {
		t.Errorf("no-op commit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(src.Dir, "HOOK_RAN")); err == nil {
		t.Fatal("a repository hook was executed")
	}
	if _, err := os.Stat(filepath.Join(cache, "hooks")); err == nil {
		if ents, _ := os.ReadDir(filepath.Join(cache, "hooks")); len(ents) > 0 {
			t.Fatalf("cache has hooks: %v", ents)
		}
	}
}
