// Package testutil builds throwaway signed project repositories for tests.
// It is imported only from _test files.
package testutil

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/ghvstcode/agentfund/worker/internal/gitx"
	"github.com/ghvstcode/agentfund/worker/internal/lockfile"
	"github.com/ghvstcode/agentfund/worker/internal/minisign"
)

// Repo is a non-bare git repository in a temp dir.
type Repo struct {
	T   testing.TB
	Dir string
}

var commitEnv = []string{
	"GIT_AUTHOR_NAME=Test", "GIT_AUTHOR_EMAIL=test@example.invalid",
	"GIT_COMMITTER_NAME=Test", "GIT_COMMITTER_EMAIL=test@example.invalid",
}

// NewRepo creates an empty repository on branch main.
func NewRepo(t testing.TB) *Repo {
	t.Helper()
	r := &Repo{T: t, Dir: t.TempDir()}
	r.Git("init", "-q", "-b", "main")
	return r
}

// Git runs git in the repo and returns trimmed stdout.
func (r *Repo) Git(args ...string) string {
	r.T.Helper()
	out, err := gitx.Cmd{Dir: r.Dir, Args: args, Env: commitEnv}.Run(context.Background())
	if err != nil {
		r.T.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

// Write creates or replaces a file.
func (r *Repo) Write(rel string, content []byte) {
	r.T.Helper()
	p := filepath.Join(r.Dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.T.Fatal(err)
	}
	if err := os.WriteFile(p, content, 0o644); err != nil {
		r.T.Fatal(err)
	}
}

// Read returns a worktree file.
func (r *Repo) Read(rel string) []byte {
	r.T.Helper()
	b, err := os.ReadFile(filepath.Join(r.Dir, filepath.FromSlash(rel)))
	if err != nil {
		r.T.Fatal(err)
	}
	return b
}

// Remove deletes a file.
func (r *Repo) Remove(rel string) {
	r.T.Helper()
	if err := os.Remove(filepath.Join(r.Dir, filepath.FromSlash(rel))); err != nil {
		r.T.Fatal(err)
	}
}

// Commit stages everything and commits; it returns the commit id.
func (r *Repo) Commit(msg string) string {
	r.T.Helper()
	r.Git("add", "-A")
	r.Git("commit", "-q", "--allow-empty", "-m", msg)
	return r.Git("rev-parse", "HEAD")
}

// Manifests returns the worktree's tasks/*.yaml files keyed by repo path.
func (r *Repo) Manifests() map[string][]byte {
	r.T.Helper()
	out := map[string][]byte{}
	names, _ := filepath.Glob(filepath.Join(r.Dir, "tasks", "*.yaml"))
	sort.Strings(names)
	for _, n := range names {
		b, err := os.ReadFile(n)
		if err != nil {
			r.T.Fatal(err)
		}
		out["tasks/"+filepath.Base(n)] = b
	}
	return out
}

// Sign rebuilds and signs the lock from the worktree manifests.
func (r *Repo) Sign(key minisign.PrivateKey, rotations ...lockfile.Rotation) {
	r.T.Helper()
	l, err := lockfile.Build(r.Manifests(), rotations)
	if err != nil {
		r.T.Fatalf("build lock: %v", err)
	}
	r.SignLock(l, key)
}

// SignLock writes an arbitrary lock (possibly inconsistent on purpose) and its signature.
func (r *Repo) SignLock(l *lockfile.Lock, key minisign.PrivateKey) {
	r.T.Helper()
	raw, err := l.Marshal()
	if err != nil {
		r.T.Fatal(err)
	}
	r.SignRaw(raw, key)
}

// SignRaw writes raw lock bytes and a valid signature over them.
func (r *Repo) SignRaw(raw []byte, key minisign.PrivateKey) {
	r.T.Helper()
	sig, err := minisign.Sign(key, raw, lockfile.TrustedComment(key.Public()), "test")
	if err != nil {
		r.T.Fatal(err)
	}
	r.Write(lockfile.Path, raw)
	r.Write(lockfile.SigPath, sig)
}

// Key generates a key pair.
func Key(t testing.TB) minisign.PrivateKey {
	t.Helper()
	k, err := minisign.GenerateKey()
	if err != nil {
		t.Fatal(err)
	}
	return k
}

// Root returns the monorepo root.
func Root(t testing.TB) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("no caller info")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

// CopyHello copies examples/hello-project (without its lock, signature,
// example key and descriptor key) into the repo worktree and rewrites the
// descriptor's pubkey to pk.
func (r *Repo) CopyHello(pk minisign.PublicKey) {
	r.T.Helper()
	src := filepath.Join(Root(r.T), "examples", "hello-project")
	err := filepath.WalkDir(src, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if rel == ".example-key" {
				return filepath.SkipDir
			}
			return nil
		}
		if rel == lockfile.Path || rel == lockfile.SigPath {
			return nil
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		if rel == "agentfund.yaml" {
			lines := strings.Split(string(b), "\n")
			for i, l := range lines {
				if strings.HasPrefix(l, "pubkey:") {
					lines[i] = "pubkey: " + pk.String()
				}
			}
			b = []byte(strings.Join(lines, "\n"))
		}
		r.Write(rel, b)
		return nil
	})
	if err != nil {
		r.T.Fatal(err)
	}
}

// HelloRepo returns a repo holding the signed hello project and its head commit.
func HelloRepo(t testing.TB, key minisign.PrivateKey) (*Repo, string) {
	t.Helper()
	r := NewRepo(t)
	r.CopyHello(key.Public())
	r.Sign(key)
	return r, r.Commit("initial")
}
