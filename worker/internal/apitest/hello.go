package apitest

import (
	"sort"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/lockfile"
	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/spec"
	"github.com/agentfund/agentfund/worker/internal/testutil"
)

// Hello is a fake instance serving a signed file:// copy of examples/hello-project.
type Hello struct {
	Server *Server
	Repo   *testutil.Repo
	Key    minisign.PrivateKey
	Commit string
}

// TaskSpecs derives the server's task rows from the manifests in a repo worktree.
func TaskSpecs(t testing.TB, repo *testutil.Repo) []TaskSpec {
	t.Helper()
	var out []TaskSpec
	for p, raw := range repo.Manifests() {
		m, err := spec.ParseManifestAt(p, raw)
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, TaskSpec{
			ManifestID: m.ID, Title: m.Title, ContentHash: lockfile.SHA256Hex(raw), MaxTokens: m.MaxTokens, Prompt: m.Prompt,
			Verify: m.Verify, Write: m.Scope.Write, Read: m.Scope.Read, DependsOn: m.DependsOn, Claimable: len(m.DependsOn) == 0,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ManifestID < out[j].ManifestID })
	return out
}

// NewHello builds the fixture. mutate may edit the worktree before signing.
func NewHello(t testing.TB, mutate func(repo *testutil.Repo)) *Hello {
	t.Helper()
	key := testutil.Key(t)
	repo := testutil.NewRepo(t)
	repo.CopyHello(key.Public())
	if mutate != nil {
		mutate(repo)
	}
	repo.Sign(key)
	commit := repo.Commit("initial")

	srv := New(t)
	srv.RepoURL, srv.Commit = "file://"+repo.Dir, commit
	srv.Pubkey, srv.Fingerprint = key.Public().String(), key.Public().Fingerprint()
	srv.LockSHA256 = lockfile.SHA256Hex(repo.Read(lockfile.Path))
	srv.Tasks = TaskSpecs(t, repo)
	return &Hello{Server: srv, Repo: repo, Key: key, Commit: commit}
}
