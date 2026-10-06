package githost

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/testutil"
)

var ctx = context.Background()

func TestBranchName(t *testing.T) {
	b, err := BranchName("0001-slugify", "clm_k3j9x0aq7m2p4r8t")
	if err != nil || b != "agentfund/0001-slugify-k3j9x0aq" {
		t.Fatalf("%q %v", b, err)
	}
	for _, bad := range [][2]string{{"0001-slugify", "k3j9x0aq7m2p4r8t"}, {"0001-slugify", "clm_abc"}, {"../x", "clm_k3j9x0aq7m2p4r8t"}, {"0001-a b", "clm_k3j9x0aq7m2p4r8t"}, {"0001-a", "clm_../../../x"}, {"0001-a", "clm_ABCDEFGH1234"}} {
		if b, err := BranchName(bad[0], bad[1]); err == nil {
			t.Errorf("BranchName(%q,%q) = %q", bad[0], bad[1], b)
		}
	}
}

func TestCommitMessageTrailers(t *testing.T) {
	msg := CommitMessage("slugify()\nfor  titles", "hello:0001-slugify", "clm_k3j9x0aq7m2p4r8t", strings.Repeat("a", 64))
	lines := strings.Split(msg, "\n")
	if lines[0] != "slugify() for titles" || lines[1] != "" {
		t.Fatalf("subject: %q", lines[:2])
	}
	for _, want := range []string{"AgentFund-Task: hello:0001-slugify", "AgentFund-Claim: clm_k3j9x0aq7m2p4r8t", "AgentFund-Manifest-SHA256: " + strings.Repeat("a", 64)} {
		if !strings.Contains(msg, "\n"+want+"\n") {
			t.Errorf("missing trailer %q in:\n%s", want, msg)
		}
	}
}

func TestFor(t *testing.T) {
	if h, err := For("file:///tmp/x"); err != nil || h.Name() != "local" {
		t.Fatalf("%v %v", h, err)
	}
	if h, err := For("https://github.com/a/b"); err != nil || h.Name() != "github" {
		t.Fatalf("%v %v", h, err)
	}
	for _, bad := range []string{"https://gitlab.com/a/b", "ssh://git@github.com/a/b", "https://github.com.evil.example/a/b", "::"} {
		if _, err := For(bad); err == nil {
			t.Errorf("For(%q) accepted", bad)
		}
	}
}

func TestParseGitHubRepo(t *testing.T) {
	for in, want := range map[string]string{
		"https://github.com/example/hello-project":     "example/hello-project",
		"https://github.com/example/hello-project.git": "example/hello-project",
		"https://github.com/example/hello-project/":    "example/hello-project",
		"https://GitHub.com/Ex-Ample/a.b_c":            "Ex-Ample/a.b_c",
	} {
		o, r, err := ParseGitHubRepo(in)
		if err != nil || o+"/"+r != want {
			t.Errorf("%s -> %s/%s %v", in, o, r, err)
		}
	}
	for _, bad := range []string{"https://github.com/onlyowner", "https://github.com/a/b/c", "https://github.com/a/..", "https://x@github.com/a/b", "http://github.com/a/b",
		"https://github.com/-a/b", "https://github.com/a/b?x=1#y", "https://github.com/a b/c", "https://github.com/a/b;rm"} {
		if o, r, err := ParseGitHubRepo(bad); err == nil {
			t.Errorf("accepted %q as %s/%s", bad, o, r)
		}
	}
}

func baseRequest(t *testing.T) (Request, *testutil.Repo, string) {
	t.Helper()
	origin := testutil.NewRepo(t)
	origin.Write("README.md", []byte("# r\n"))
	origin.Write("src/a.py", []byte("a = 1\n"))
	c := origin.Commit("init")
	cache := gitx.CachePath(t.TempDir(), "file://"+origin.Dir)
	if err := gitx.Fetch(ctx, cache, "file://"+origin.Dir, c); err != nil {
		t.Fatal(err)
	}
	return Request{
		RepoDir: cache, RepoURL: "file://" + origin.Dir, BaseBranch: "main", BaseCommit: c, Branch: "agentfund/0001-slugify-k3j9x0aq",
		Changes: []gitx.TreeChange{{Path: "src/a.py", Mode: "100644", Content: []byte("a = 2\n")}, {Path: "tests/t.py", Mode: "100644", Content: []byte("t\n")}},
		Title:   "slugify", Body: "body", Message: CommitMessage("slugify", "hello:0001-slugify", "clm_k3j9x0aq7m2p4r8t", strings.Repeat("a", 64)),
	}, origin, c
}

func TestLocalPublish(t *testing.T) {
	req, origin, base := baseRequest(t)
	pub, err := Local{}.Publish(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if pub.Branch != req.Branch || pub.PRURL != req.RepoURL+"#"+req.Branch || len(pub.HeadSHA) != 40 {
		t.Fatalf("%+v", pub)
	}
	if got := origin.Git("rev-parse", "refs/heads/"+req.Branch); got != pub.HeadSHA {
		t.Fatalf("origin branch at %s, want %s", got, pub.HeadSHA)
	}
	if got := origin.Git("rev-parse", pub.HeadSHA+"^"); got != base {
		t.Fatalf("parent %s, want %s", got, base)
	}
	if got := origin.Git("show", pub.HeadSHA+":src/a.py"); got != "a = 2" {
		t.Fatalf("content %q", got)
	}
	if got := origin.Git("diff", "--name-status", base, pub.HeadSHA); got != "M\tsrc/a.py\nA\ttests/t.py" {
		t.Fatalf("diff %q", got)
	}
	if got := origin.Git("log", "-1", "--format=%an|%ae|%(trailers:key=AgentFund-Claim,valueonly)", pub.HeadSHA); !strings.HasPrefix(got, AuthorName+"|"+AuthorEmail+"|clm_k3j9x0aq7m2p4r8t") {
		t.Fatalf("commit meta %q", got)
	}
	if origin.Git("rev-parse", "refs/heads/main") != base {
		t.Fatal("main moved")
	}

	// Refusals.
	bad := req
	bad.Branch = "main"
	if _, err := (Local{}).Publish(ctx, bad); err == nil {
		t.Error("pushed to main")
	}
	bad = req
	bad.Branch = "agentfund/../../heads/main"
	if _, err := (Local{}).Publish(ctx, bad); err == nil {
		t.Error("pushed to a traversal branch")
	}
	bad = req
	bad.Changes = nil
	if _, err := (Local{}).Publish(ctx, bad); !errors.Is(err, gitx.ErrNoChanges) {
		t.Errorf("empty change set: %v", err)
	}
	bad = req
	bad.RepoURL = "https://github.com/a/b"
	if _, err := (Local{}).Publish(ctx, bad); err == nil {
		t.Error("local publisher accepted an https URL")
	}
}

type ghCall struct{ args []string }

func fakeGH(login string, calls *[]ghCall, failCreate bool) CommandRunner {
	return func(_ context.Context, name string, args ...string) (string, error) {
		*calls = append(*calls, ghCall{append([]string{name}, args...)})
		j := strings.Join(args, " ")
		switch {
		case strings.HasPrefix(j, "api user"):
			return login, nil
		case strings.HasPrefix(j, "repo fork"):
			return "", nil
		case strings.HasPrefix(j, "api graphql"):
			return login + "/hello-fork", nil
		case strings.HasPrefix(j, "pr create"):
			if failCreate {
				return "", errors.New("a pull request for branch already exists")
			}
			return "Creating pull request...\nhttps://github.com/example/hello/pull/7", nil
		case strings.HasPrefix(j, "pr view"):
			return "https://github.com/example/hello/pull/7", nil
		}
		return "", errors.New("unexpected gh call: " + j)
	}
}

func TestGitHubPublishFlow(t *testing.T) {
	req, _, _ := baseRequest(t)
	req.RepoURL = "https://github.com/example/hello"

	var calls []ghCall
	var pushes []string
	attempts := 0
	g := &GitHub{
		Run: fakeGH("donor", &calls, false),
		Push: func(_ context.Context, repoDir, pushURL, sha, branch string) error {
			attempts++
			if attempts < 3 {
				return errors.New("fork not ready")
			}
			pushes = append(pushes, pushURL+" "+branch+" "+sha)
			return nil
		},
		RetryDelay: 1,
	}
	pub, err := g.Publish(ctx, req)
	if err != nil {
		t.Fatal(err)
	}
	if pub.PRURL != "https://github.com/example/hello/pull/7" || pub.Branch != req.Branch || len(pub.HeadSHA) != 40 {
		t.Fatalf("%+v", pub)
	}
	if len(pushes) != 1 || !strings.HasPrefix(pushes[0], "https://github.com/donor/hello-fork.git agentfund/0001-slugify-k3j9x0aq ") {
		t.Fatalf("pushes %v", pushes)
	}
	var create []string
	for _, c := range calls {
		if len(c.args) > 2 && c.args[1] == "pr" && c.args[2] == "create" {
			create = c.args
		}
	}
	j := strings.Join(create, " ")
	for _, want := range []string{"--repo example/hello", "--base main", "--head donor:agentfund/0001-slugify-k3j9x0aq", "--title slugify", "--body body"} {
		if !strings.Contains(j, want) {
			t.Errorf("pr create lacks %q: %s", want, j)
		}
	}
	if !strings.Contains(strings.Join(calls[1].args, " "), "repo fork example/hello --clone=false") {
		t.Errorf("fork call: %v", calls[1].args)
	}

	// The project owner pushes to the project itself: no fork, plain head.
	calls, pushes, attempts = nil, nil, 5
	g.Run = fakeGH("example", &calls, false)
	if _, err := g.Publish(ctx, req); err != nil {
		t.Fatal(err)
	}
	for _, c := range calls {
		if strings.Contains(strings.Join(c.args, " "), "fork") {
			t.Errorf("owner should not fork: %v", c.args)
		}
	}
	if !strings.HasPrefix(pushes[0], "https://github.com/example/hello.git ") {
		t.Fatalf("owner push %v", pushes)
	}

	// An existing PR is reused.
	calls = nil
	g.Run = fakeGH("donor", &calls, true)
	if pub, err := g.Publish(ctx, req); err != nil || pub.PRURL != "https://github.com/example/hello/pull/7" {
		t.Fatalf("existing PR: %+v %v", pub, err)
	}

	// Not logged in.
	g.Run = func(context.Context, string, ...string) (string, error) { return "", errors.New("not logged in") }
	if _, err := g.Publish(ctx, req); err == nil || !strings.Contains(err.Error(), "gh auth login") {
		t.Fatalf("not logged in: %v", err)
	}
	// Push never succeeds.
	g.Run = fakeGH("donor", &calls, false)
	g.Push = func(context.Context, string, string, string, string) error { return errors.New("denied") }
	if _, err := g.Publish(ctx, req); err == nil || !strings.Contains(err.Error(), "denied") {
		t.Fatalf("push failure: %v", err)
	}
}
