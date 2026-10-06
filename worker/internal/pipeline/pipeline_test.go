package pipeline

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/apitest"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/githost"
	"github.com/agentfund/agentfund/worker/internal/lockfile"
	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/runner"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/testutil"
)

const testSecret = "sk-ant-oat01-TESTSECRET-do-not-leak-0123456789abcdef"

// noSandboxEngine answers the harmless queries Prepare makes and fails the
// test if the pipeline tries to create anything: these tests cover the
// refusal paths that must end before a sandbox exists.
type noSandboxEngine struct {
	t  *testing.T
	mu sync.Mutex
	n  int
}

func (e *noSandboxEngine) Output(_ context.Context, args ...string) (string, error) {
	switch args[0] {
	case "version":
		return "0.0-test", nil
	case "image":
		return "sha256:test", nil
	case "ps":
		return "", nil
	case "volume", "network":
		if args[1] == "ls" {
			return "", nil
		}
	}
	e.mu.Lock()
	e.n++
	e.mu.Unlock()
	e.t.Errorf("the pipeline touched the container engine before it was allowed to: docker %s", strings.Join(args, " "))
	return "", errors.New("no sandbox in this test")
}

func (e *noSandboxEngine) Stream(_ context.Context, _ io.Reader, _, _ io.Writer, _ []string, args ...string) (int, error) {
	_, err := e.Output(context.Background(), args...)
	return 1, err
}

type fixture struct {
	t      *testing.T
	key    minisign.PrivateKey
	repo   *testutil.Repo
	commit string
	srv    *apitest.Server
	w      *Worker
	dir    string
}

// newFixture wires a worker to a fake server and a signed file:// copy of hello-project.
func newFixture(t *testing.T, mutate func(repo *testutil.Repo)) *fixture {
	t.Helper()
	h := apitest.NewHello(t, mutate)
	key, repo, commit, srv := h.Key, h.Repo, h.Commit, h.Server

	dir := t.TempDir()
	cfg := config.Default()
	cfg.Global.AllowedGitHosts = []string{"file"}
	ref := config.Ref{Server: srv.URL, Slug: srv.Slug}
	proj := &config.Project{Server: srv.URL, Slug: srv.Slug, Pubkey: key.Public().String(), ApprovedCommit: commit, ApprovedLockSHA256: srv.LockSHA256}
	cfg.Projects[ref.Key()] = proj
	w := &Worker{
		Cfg: cfg, Ref: ref, Project: proj, API: api.New(srv.URL, srv.APIKey),
		Store: store.Open(filepath.Join(dir, "state.json")), Engine: &noSandboxEngine{t: t}, Runner: runner.NewClaudeCode(),
		HostFor: githost.For, ReposDir: filepath.Join(dir, "repos"), LogsDir: filepath.Join(dir, "logs"),
		LookupEnv: func(k string) (string, bool) {
			if k == runner.EnvOAuthToken {
				return testSecret, true
			}
			return "", false
		},
	}
	return &fixture{t: t, key: key, repo: repo, commit: commit, srv: srv, w: w, dir: dir}
}

func (f *fixture) once() ([]Result, error) {
	var res []Result
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	err := f.w.Work(ctx, LoopOptions{Once: true, Poll: 50 * time.Millisecond, OnResult: func(r Result) { res = append(res, r) }})
	return res, err
}

func (f *fixture) onlyOutcome() apitest.Outcome {
	f.t.Helper()
	out := f.srv.Outcomes()
	if len(out) != 1 {
		f.t.Fatalf("expected exactly one claim, got %d: %+v", len(out), out)
	}
	return out[0]
}

func (f *fixture) noBranchPushed() {
	f.t.Helper()
	if b := f.repo.Git("for-each-ref", "--format=%(refname)", "refs/heads/agentfund"); b != "" {
		f.t.Fatalf("a branch was pushed although the run was refused: %s", b)
	}
}

func TestVerificationFailureReportsAndExecutesNothing(t *testing.T) {
	cases := map[string]func(f *fixture){
		"donor pinned a different key": func(f *fixture) { f.w.Project.Pubkey = testutil.Key(t).Public().String() },
		"claim names another content hash": func(f *fixture) {
			f.srv.Lock()
			f.srv.Tasks[0].ContentHash = strings.Repeat("0", 64)
			f.srv.Unlock()
		},
		"claim names a commit the approval does not cover (listing showed the approved one)": func(f *fixture) {
			f.repo.Write("src/new.py", []byte("# moved on\n"))
			newer := f.repo.Commit("code moved")
			f.srv.Lock()
			f.srv.ClaimCommit = newer
			f.srv.Unlock()
		},
		"lock tampered after signing": func(f *fixture) {
			f.repo.Write(lockfile.Path, append(f.repo.Read(lockfile.Path), ' '))
			c := f.repo.Commit("tamper")
			f.srv.Lock()
			f.srv.Commit = c
			f.srv.Unlock()
			f.w.Project.ApprovedCommit = c
		},
		"claim names a nonexistent commit": func(f *fixture) {
			f.srv.Lock()
			f.srv.Commit = strings.Repeat("d", 40)
			f.srv.Unlock()
		},
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, nil)
			mut(f)
			res, err := f.once()
			if err != nil {
				t.Fatal(err)
			}
			if len(res) != 1 || res[0].Outcome != api.StatusVerificationFailed {
				t.Fatalf("results: %+v", res)
			}
			o := f.onlyOutcome()
			if o.Status != "reported" || o.Report["status"] != api.StatusVerificationFailed || o.Report["tokens_in"] != float64(0) {
				t.Fatalf("server saw %+v", o)
			}
			if !strings.Contains(o.Report["message"].(string), "verification failed at step") {
				t.Fatalf("message %q", o.Report["message"])
			}
			f.noBranchPushed()
			// The digest reported is the digest of the local log.
			got, _ := os.ReadFile(res[0].LogFile)
			if lockfile.SHA256Hex(got) != o.Report["log_digest"] || res[0].LogDigest != o.Report["log_digest"] {
				t.Fatal("log_digest does not match the log file")
			}
			st, _ := f.w.Store.Snapshot()
			if len(st.Runs) != 1 || !st.Runs[0].Settled || st.Runs[0].Status != api.StatusVerificationFailed || st.Runs[0].Counted() != 0 {
				t.Fatalf("store: %+v", st.Runs)
			}
		})
	}
}

// When the project's pin moved past the approval, nothing is claimed: the
// worker says what to do, and re-approval (which also clears the retry
// cooldown) makes the task runnable again.
func TestProjectMovedPastApprovalIsNotClaimed(t *testing.T) {
	f := newFixture(t, nil)
	f.repo.Write("src/new.py", []byte("# moved on\n"))
	newer := f.repo.Commit("code moved")
	f.srv.Lock()
	f.srv.Commit = newer
	f.srv.Unlock()

	_, err := f.once()
	want := "project moved to " + newer[:12] + "; run `agentfund approve " + f.w.Ref.Key() + "` to review and approve it"
	if !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), want) {
		t.Fatalf("want ErrNothingToDo mentioning %q, got %v", want, err)
	}
	if n := len(f.srv.Calls("/claim")); n != 0 {
		t.Fatalf("%d claim request(s) for a commit the donor never approved", n)
	}
	st, _ := f.w.Store.Snapshot()
	if len(st.Runs) != 0 {
		t.Fatalf("nothing should be recorded locally: %+v", st.Runs)
	}
	pv, err := f.w.DryRun(context.Background(), 1)
	if err != nil || len(pv) != 1 || pv[0].WouldRun || pv[0].Why != want {
		t.Fatalf("dry-run: %+v %v", pv, err)
	}
	ok, why, err := ApprovalCovers(context.Background(), f.w.Cfg, f.w.Project, f.w.Ref, f.w.ReposDir, f.srv.RepoURL, newer, false)
	if err != nil || ok || why != want {
		t.Fatalf("ApprovalCovers: %v %q %v", ok, why, err)
	}
	// An ancestor of the approved commit is covered without any policy.
	if ok, _, err := ApprovalCovers(context.Background(), f.w.Cfg, f.w.Project, f.w.Ref, f.w.ReposDir, f.srv.RepoURL, f.commit, false); err != nil || !ok {
		t.Fatalf("approved commit: %v %v", ok, err)
	}
	// With follow_unchanged_lock the code-only commit is covered (the lock bytes are identical).
	f.w.Cfg.Global.FollowUnchangedLock = true
	if ok, _, err := ApprovalCovers(context.Background(), f.w.Cfg, f.w.Project, f.w.Ref, f.w.ReposDir, f.srv.RepoURL, newer, true); err != nil || !ok {
		t.Fatalf("follow_unchanged_lock: %v %v", ok, err)
	}
	f.w.Cfg.Global.FollowUnchangedLock = false
	// A changed, re-signed task set is covered only by auto_follow_signed_updates.
	f.repo.Write("tasks/0003-cli.yaml", append(f.repo.Read("tasks/0003-cli.yaml"), []byte("# edited\n")...))
	f.repo.Sign(f.key)
	resigned := f.repo.Commit("new task text")
	f.w.Cfg.Global.FollowUnchangedLock = true
	if ok, _, _ := ApprovalCovers(context.Background(), f.w.Cfg, f.w.Project, f.w.Ref, f.w.ReposDir, f.srv.RepoURL, resigned, true); ok {
		t.Fatal("follow_unchanged_lock must not cover a changed lock")
	}
	f.w.Cfg.Global.AutoFollowSignedUpdates = true
	if ok, _, _ := ApprovalCovers(context.Background(), f.w.Cfg, f.w.Project, f.w.Ref, f.w.ReposDir, f.srv.RepoURL, resigned, true); !ok {
		t.Fatal("auto_follow_signed_updates should cover it")
	}
}

func TestRetryCooldownIsClearedByReapproval(t *testing.T) {
	f := newFixture(t, nil)
	f.srv.Lock()
	f.srv.Tasks[0].ContentHash = strings.Repeat("0", 64) // a genuine hash failure: claimed, reported verification_failed
	f.srv.Unlock()
	if res, err := f.once(); err != nil || len(res) != 1 || res[0].Outcome != api.StatusVerificationFailed {
		t.Fatalf("first pass: %+v %v", res, err)
	}
	if _, err := f.once(); !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "retry_failed_after") {
		t.Fatalf("cooldown: %v", err)
	}
	if n, err := f.w.Store.ClearRetries(f.w.Ref.Key()); err != nil || n != 1 {
		t.Fatalf("ClearRetries: %d %v", n, err)
	}
	if n, _ := f.w.Store.ClearRetries(f.w.Ref.Key()); n != 0 {
		t.Fatalf("second ClearRetries cleared %d", n)
	}
	if res, err := f.once(); err != nil || len(res) != 1 {
		t.Fatalf("after clearing the cooldown the task should be claimed again: %+v %v", res, err)
	}
	if n := len(f.srv.Outcomes()); n != 2 {
		t.Fatalf("%d claims, want 2", n)
	}
}

func TestReportDeliveryRetriesAndRefusal(t *testing.T) {
	setup := func(t *testing.T) *fixture {
		f := newFixture(t, nil)
		f.w.Project.Pubkey = testutil.Key(t).Public().String() // ends in a verification_failed report, no sandbox needed
		f.w.ReportRetryDelay = time.Millisecond
		return f
	}
	t.Run("transient failures are retried", func(t *testing.T) {
		f := setup(t)
		f.srv.Lock()
		f.srv.ReportFailures = 3
		f.srv.Unlock()
		res, err := f.once()
		if err != nil || len(res) != 1 || res[0].ReportAccepted == nil || !*res[0].ReportAccepted || res[0].ReportError != "" {
			t.Fatalf("results: %+v %v", res, err)
		}
		if n := len(f.srv.Calls("/report")); n != 4 {
			t.Fatalf("%d report attempts, want 4", n)
		}
		if o := f.onlyOutcome(); o.Status != "reported" {
			t.Fatalf("outcome: %+v", o)
		}
	})
	t.Run("gives up after a few attempts", func(t *testing.T) {
		f := setup(t)
		f.srv.Lock()
		f.srv.ReportFailures = 100
		f.srv.Unlock()
		res, err := f.once()
		if err != nil || len(res) != 1 || res[0].ReportAccepted == nil || *res[0].ReportAccepted || !strings.Contains(res[0].ReportError, "internal") {
			t.Fatalf("results: %+v %v", res, err)
		}
		if n := len(f.srv.Calls("/report")); n != 5 {
			t.Fatalf("%d report attempts, want 5", n)
		}
	})
	t.Run("a definite refusal is not retried and is surfaced", func(t *testing.T) {
		f := setup(t)
		f.srv.Lock()
		f.srv.ReportProblem = "validation"
		f.srv.Unlock()
		res, err := f.once()
		if err != nil || len(res) != 1 || res[0].ReportAccepted == nil || *res[0].ReportAccepted || !strings.Contains(res[0].ReportError, "validation") {
			t.Fatalf("results: %+v %v", res, err)
		}
		if n := len(f.srv.Calls("/report")); n != 1 {
			t.Fatalf("%d report attempts, want 1", n)
		}
		side, _ := os.ReadFile(strings.TrimSuffix(res[0].LogFile, ".log") + ".report.json")
		st, _ := f.w.Store.Snapshot()
		if !strings.Contains(string(side), "report_error") || !strings.Contains(st.Runs[0].Message, "REPORT NOT ACCEPTED") {
			t.Fatalf("refusal not recorded: sidecar %s store %+v", side, st.Runs[0])
		}
	})
	t.Run("releases are retried too", func(t *testing.T) {
		f := newFixture(t, nil)
		f.w.ReportRetryDelay = time.Millisecond
		f.srv.Lock()
		f.srv.Tasks[0].MaxTokens = 1000 // passes the pre-check; the signed manifest then exceeds the ceiling
		f.srv.ReportFailures = 2
		f.srv.Unlock()
		f.w.Cfg.Global.MaxTokensPerTask = 500_000
		res, err := f.once()
		if err != nil || len(res) != 1 || res[0].Outcome != OutcomeReleased || res[0].ReportAccepted == nil || !*res[0].ReportAccepted {
			t.Fatalf("results: %+v %v", res, err)
		}
		if o := f.onlyOutcome(); o.Status != "released" {
			t.Fatalf("outcome: %+v", o)
		}
	})
}

func TestServerRetryAfterIsHonoured(t *testing.T) {
	f := newFixture(t, nil)
	f.w.Project.Pubkey = testutil.Key(t).Public().String() // the eventual claim ends quickly, without a sandbox
	f.srv.Lock()
	f.srv.TasksRateLimited, f.srv.RetryAfterSeconds = 1, 2
	f.srv.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	done := make(chan struct{})
	start := time.Now()
	go func() {
		defer close(done)
		_ = f.w.Work(ctx, LoopOptions{Poll: 10 * time.Millisecond, OnResult: func(Result) { cancel() }})
	}()
	<-done
	listings := f.srv.Calls("/v1/projects/hello-project/tasks")
	if len(listings) != 2 {
		t.Fatalf("%d task listings; after a 429 with Retry-After: 2 the worker must wait, not poll every 10ms", len(listings))
	}
	if el := time.Since(start); el < 2*time.Second {
		t.Fatalf("worker came back after %s, before the server's Retry-After of 2s", el)
	}
	if len(f.srv.Outcomes()) != 1 {
		t.Fatalf("after the wait the worker should carry on: %+v", f.srv.Outcomes())
	}
}

func TestFollowPoliciesAllowNewerCommit(t *testing.T) {
	// With follow_unchanged_lock the newer, code-only commit passes verification and the
	// run proceeds to the sandbox — which this test's engine refuses, proving how far it got.
	f := newFixture(t, nil)
	f.repo.Write("src/new.py", []byte("# moved on\n"))
	newer := f.repo.Commit("code moved")
	f.srv.Lock()
	f.srv.Commit = newer
	f.srv.Unlock()
	f.w.Cfg.Global.FollowUnchangedLock = true
	eng := &permissiveEngine{}
	f.w.Engine = eng
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Outcome != OutcomeReleased || !strings.Contains(res[0].Reason, "cannot start the sandbox") {
		t.Fatalf("results: %+v", res)
	}
	if !eng.sawNetworkCreate {
		t.Fatal("verification should have passed and the sandbox start been attempted")
	}
}

// permissiveEngine lets Prepare pass and fails sandbox creation without failing the test.
type permissiveEngine struct{ sawNetworkCreate bool }

func (e *permissiveEngine) Output(_ context.Context, args ...string) (string, error) {
	switch args[0] {
	case "version", "image", "ps":
		return "", nil
	}
	if (args[0] == "volume" || args[0] == "network") && args[1] == "ls" {
		return "", nil
	}
	if args[0] == "network" && args[1] == "create" {
		e.sawNetworkCreate = true
		return "", errors.New("engine unavailable in unit tests")
	}
	return "", nil
}
func (e *permissiveEngine) Stream(context.Context, io.Reader, io.Writer, io.Writer, []string, ...string) (int, error) {
	return 1, errors.New("engine unavailable in unit tests")
}

func TestPolicyRefusalAfterVerificationReleasesTheClaim(t *testing.T) {
	// The server understates max_tokens in its task listing; the signed manifest
	// says 1,000,000. The pre-check passes, the authoritative check refuses.
	f := newFixture(t, nil)
	f.srv.Lock()
	f.srv.Tasks[0].MaxTokens = 1000
	f.srv.Unlock()
	f.w.Cfg.Global.MaxTokensPerTask = 500_000
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Outcome != OutcomeReleased || !strings.Contains(res[0].Reason, "max_tokens_per_task") {
		t.Fatalf("results: %+v", res)
	}
	o := f.onlyOutcome()
	if o.Status != "released" || o.Report != nil || !strings.Contains(o.Release["reason"].(string), "donor policy") {
		t.Fatalf("server saw %+v", o)
	}
	if _, has := o.Release["tokens_in"]; has {
		t.Fatalf("no tokens were burned, none should be reported: %+v", o.Release)
	}
	st, _ := f.w.Store.Snapshot()
	if g, _, active := store.UsageOf(st, time.Now(), f.w.Ref.Key()); g.Day != 0 || active != 0 {
		t.Fatalf("a refused run must not consume budget: %+v active=%d", g, active)
	}
}

func TestPrecheckRefusalsNeverClaim(t *testing.T) {
	cases := map[string]func(f *fixture){
		"task ceiling":    func(f *fixture) { f.w.Cfg.Global.MaxTokensPerTask = 999_999 },
		"daily cap":       func(f *fixture) { f.w.Cfg.Global.TokensPerDay = 999_999 },
		"weekly cap":      func(f *fixture) { f.w.Cfg.Global.TokensPerWeek = 999_999 },
		"session budget":  func(f *fixture) { f.w.SessionBudget = 999_999 },
		"git host":        func(f *fixture) { f.w.Cfg.Global.AllowedGitHosts = []string{"github.com"} },
		"schedule closed": func(f *fixture) { f.w.Cfg.Global.Schedule = []string{closedWindow()} },
		"backoff":         func(f *fixture) { f.w.Store.SetBackoff(policyBackoff(time.Now().Add(time.Hour))) },
		"new-project ceiling": func(f *fixture) {
			f.srv.Lock()
			f.srv.TrustTier = "new"
			f.srv.Unlock()
			f.w.Cfg.Global.NewProjectMaxTokensPerTask = 500_000
		},
		"server cap for new projects": func(f *fixture) {
			cap := int64(10_000)
			f.srv.Lock()
			f.srv.TrustTier, f.srv.TrustTaskCap = "new", &cap
			f.srv.Unlock()
		},
		"project override": func(f *fixture) { v := config.Tokens(10); f.w.Project.TokensPerDay = &v },
	}
	for name, mut := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t, nil)
			mut(f)
			res, err := f.once()
			if !errors.Is(err, ErrNothingToDo) {
				t.Fatalf("want ErrNothingToDo, got %v (results %+v)", err, res)
			}
			if n := len(f.srv.Outcomes()); n != 0 {
				t.Fatalf("%d claim(s) were made although policy refuses", n)
			}
		})
	}
}

func TestPrepareFailsBeforeClaiming(t *testing.T) {
	t.Run("no agent credentials", func(t *testing.T) {
		f := newFixture(t, nil)
		f.w.LookupEnv = func(string) (string, bool) { return "", false }
		_, err := f.once()
		if err == nil || !strings.Contains(err.Error(), "CLAUDE_CODE_OAUTH_TOKEN") || !strings.Contains(err.Error(), "ANTHROPIC_API_KEY") {
			t.Fatalf("err = %v", err)
		}
		if len(f.srv.Calls("/claim")) != 0 {
			t.Fatal("claimed without credentials")
		}
	})
	t.Run("server lacks protocol v1", func(t *testing.T) {
		f := newFixture(t, nil)
		f.srv.Lock()
		f.srv.ProtocolVersions = []string{"v2"}
		f.srv.Unlock()
		if _, err := f.once(); err == nil || !strings.Contains(err.Error(), "protocol v1") {
			t.Fatalf("err = %v", err)
		}
		if len(f.srv.Calls("/claim")) != 0 {
			t.Fatal("claimed despite failed negotiation")
		}
	})
	t.Run("server lacks spec version 1", func(t *testing.T) {
		f := newFixture(t, nil)
		f.srv.Lock()
		f.srv.SpecVersions = []int{2}
		f.srv.Unlock()
		if _, err := f.once(); err == nil || !strings.Contains(err.Error(), "spec_version") {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("bad schedule in config", func(t *testing.T) {
		f := newFixture(t, nil)
		f.w.Cfg.Global.Schedule = []string{"25:00-26:00"}
		if _, err := f.once(); err == nil {
			t.Fatal("accepted an invalid schedule")
		}
	})
}

func TestClaimRefusalsAreSkipped(t *testing.T) {
	for _, code := range []string{api.CodeTaskNotOpen, api.CodeDependenciesUnmet, api.CodeClaimLimit, api.CodeProjectTaskCap, api.CodeProjectDailyCap, api.CodeProjectNotActive} {
		t.Run(code, func(t *testing.T) {
			f := newFixture(t, nil)
			f.srv.Lock()
			f.srv.ClaimProblem = code
			f.srv.Unlock()
			res, err := f.once()
			if err != nil {
				t.Fatal(err)
			}
			if len(res) != 1 || res[0].Outcome != OutcomeSkipped || !strings.Contains(res[0].Reason, code) {
				t.Fatalf("results: %+v", res)
			}
		})
	}
}

func TestTaskOptionFetchesOneTask(t *testing.T) {
	f := newFixture(t, nil)
	ctx := context.Background()
	err := f.w.Work(ctx, LoopOptions{Once: true, TaskID: "0002-truncate"})
	if !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "0002-truncate") || !strings.Contains(err.Error(), "not claimable") {
		t.Fatalf("blocked task: %v", err)
	}
	if n := len(f.srv.Calls("/v1/tasks/hello-project:0002-truncate")); n != 1 {
		t.Fatalf("expected one getTask call, saw %d", n)
	}
	if len(f.srv.Calls("/tasks?")) != 0 && len(f.srv.Calls("/v1/projects/hello-project/tasks")) != 0 {
		t.Fatal("--task should not list the whole queue")
	}
	if err := f.w.Work(ctx, LoopOptions{Once: true, TaskID: "0009-nope"}); !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "not-found") {
		t.Fatalf("unknown task: %v", err)
	}
	if len(f.srv.Outcomes()) != 0 {
		t.Fatal("nothing should have been claimed")
	}
}

func TestDryRunClaimsNothing(t *testing.T) {
	f := newFixture(t, nil)
	f.w.Cfg.Global.TokensPerDay = 1_500_000 // room for one 1M task
	pv, err := f.w.DryRun(context.Background(), 5)
	if err != nil {
		t.Fatal(err)
	}
	if len(pv) != 3 {
		t.Fatalf("previews: %+v", pv)
	}
	if !pv[0].WouldRun || pv[0].Task != "0001-slugify" || pv[0].Manifest == nil || !strings.Contains(pv[0].Manifest.Prompt, "slugify(text: str)") {
		t.Fatalf("first preview: %+v", pv[0])
	}
	if pv[1].WouldRun || !strings.Contains(pv[1].Why, "not claimable") || pv[1].Manifest == nil {
		t.Fatalf("second preview: %+v", pv[1])
	}
	for _, c := range f.srv.Calls("") {
		if c.Method != "GET" {
			t.Fatalf("dry-run made a non-GET request: %s %s", c.Method, c.Path)
		}
	}
	// A manifest that does not verify is shown as skipped, without its (untrusted) prompt.
	f.w.Project.Pubkey = testutil.Key(t).Public().String()
	pv, _ = f.w.DryRun(context.Background(), 1)
	if len(pv) != 1 || pv[0].WouldRun || pv[0].Manifest != nil || !strings.Contains(pv[0].Why, "verification failed") {
		t.Fatalf("unverified preview: %+v", pv)
	}
}

func TestEgressAllowlistIsMinimal(t *testing.T) {
	f := newFixture(t, nil)
	got := strings.Join(f.w.egressAllowlist("https://github.com/example/hello"), ",")
	if got != "api.anthropic.com" {
		t.Fatalf("default allowlist must be the model API only: %s", got)
	}
	f.w.Cfg.Global.Sandbox.AllowGitHost = true
	if got := strings.Join(f.w.egressAllowlist("https://github.com/example/hello"), ","); got != "api.anthropic.com,github.com" {
		t.Fatalf("allow_git_host allowlist: %s", got)
	}
	if got := strings.Join(f.w.egressAllowlist("file:///tmp/x"), ","); got != "api.anthropic.com" {
		t.Fatalf("file repo allowlist: %s", got)
	}
	// An API key or pass_env does not widen the allowlist by itself; only explicit donor config does.
	f.w.Cfg.Global.Sandbox.PassEnv = []string{"ANTHROPIC_BASE_URL"}
	if got := strings.Join(f.w.egressAllowlist("https://github.com/a/b"), ","); got != "api.anthropic.com,github.com" {
		t.Fatalf("pass_env must not widen egress: %s", got)
	}
	f.w.Cfg.Global.Sandbox.ExtraAllowHosts = []string{"gateway.example:8443", "API.anthropic.com"}
	if got := strings.Join(f.w.egressAllowlist("https://github.com/a/b"), ","); got != "api.anthropic.com,github.com,gateway.example:8443" {
		t.Fatalf("extra hosts: %s", got)
	}
}
