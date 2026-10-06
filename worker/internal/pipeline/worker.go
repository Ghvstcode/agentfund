// Package pipeline is the worker's execution engine: it turns "a claimable
// task" into "a verified, sandboxed, metered run and exactly one report or
// release". Every refusal path ends in a teardown of the sandbox.
package pipeline

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/githost"
	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/runner"
	"github.com/agentfund/agentfund/worker/internal/sandbox"
	"github.com/agentfund/agentfund/worker/internal/scope"
	"github.com/agentfund/agentfund/worker/internal/spec"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

// Outcomes of one task attempt, beyond the wire report statuses.
const (
	OutcomeReleased = "released"
	OutcomeSkipped  = "skipped"
	OutcomeAborted  = "aborted"
)

// Result summarises one task attempt.
type Result struct {
	Task      string  `json:"task"`
	Claim     string  `json:"claim,omitempty"`
	Outcome   string  `json:"outcome"`
	Reason    string  `json:"reason,omitempty"`
	TokensIn  int64   `json:"tokens_in"`
	TokensOut int64   `json:"tokens_out"`
	Cost      float64 `json:"cost_estimate,omitempty"`
	Branch    string  `json:"branch,omitempty"`
	PRURL     string  `json:"pr_url,omitempty"`
	HeadSHA   string  `json:"head_sha,omitempty"`
	LogFile   string  `json:"log_file,omitempty"`
	LogDigest string  `json:"log_digest,omitempty"`
}

// ErrFatal wraps conditions under which the worker must stop claiming tasks
// (e.g. the provider rejects the donor's credentials).
type ErrFatal struct{ Err error }

func (e *ErrFatal) Error() string { return e.Err.Error() }
func (e *ErrFatal) Unwrap() error { return e.Err }

// Worker runs tasks of one approved project.
type Worker struct {
	Cfg     *config.Config
	Ref     config.Ref
	Project *config.Project
	API     *api.Client
	Store   *store.Store
	Engine  sandbox.Engine
	Runner  runner.Runner
	HostFor func(repoURL string) (githost.Host, error)

	ReposDir string
	LogsDir  string
	Limits   scope.Limits
	// LookupEnv reads the donor's environment (os.LookupEnv in production).
	LookupEnv func(string) (string, bool)
	// Out receives human-readable progress lines.
	Out io.Writer
	Now func() time.Time
	// SessionBudget caps the tokens reserved by this invocation (0 = none).
	SessionBudget int64

	meta        *api.Meta
	creds       runner.Credentials
	sessionUsed atomic.Int64
	repoLocks   sync.Map // repo cache dir -> *sync.Mutex
	inFlight    sync.Map // manifest id -> struct{}
	active      atomic.Int32
}

func (w *Worker) now() time.Time {
	if w.Now != nil {
		return w.Now()
	}
	return time.Now()
}

func (w *Worker) say(format string, a ...any) {
	if w.Out != nil {
		fmt.Fprintf(w.Out, "%s  %s\n", w.now().Format("15:04:05"), fmt.Sprintf(format, a...))
	}
}

// EffectiveLimits resolves the global and per-project policy from config.
func EffectiveLimits(cfg *config.Config, p *config.Project) (policy.Limits, policy.ProjectLimits, verify.Policy, error) {
	g := cfg.Global
	sched, err := policy.ParseSchedule(g.Schedule)
	if err != nil {
		return policy.Limits{}, policy.ProjectLimits{}, verify.Policy{}, fmt.Errorf("global.schedule: %w", err)
	}
	lim := policy.Limits{
		TokensPerDay: int64(g.TokensPerDay), TokensPerWeek: int64(g.TokensPerWeek), MaxTokensPerTask: int64(g.MaxTokensPerTask),
		NewProjectMaxTokensPerTask: int64(g.NewProjectMaxTokensPerTask), Schedule: sched, MaxConcurrent: g.MaxConcurrent,
		AllowedGitHosts: g.AllowedGitHosts,
	}
	vp := verify.Policy{FollowUnchangedLock: g.FollowUnchangedLock, AutoFollowSignedUpdates: g.AutoFollowSignedUpdates}
	var pl policy.ProjectLimits
	if p != nil {
		conv := func(t *config.Tokens) *int64 {
			if t == nil {
				return nil
			}
			v := int64(*t)
			return &v
		}
		pl.TokensPerDay, pl.TokensPerWeek, pl.MaxTokensPerTask = conv(p.TokensPerDay), conv(p.TokensPerWeek), conv(p.MaxTokensPerTask)
		if p.Schedule != nil {
			ps, err := policy.ParseSchedule(*p.Schedule)
			if err != nil {
				return lim, pl, vp, fmt.Errorf("project schedule: %w", err)
			}
			pl.Schedule = &ps
		}
		if p.FollowUnchangedLock != nil {
			vp.FollowUnchangedLock = *p.FollowUnchangedLock
		}
		if p.AutoFollowSignedUpdates != nil {
			vp.AutoFollowSignedUpdates = *p.AutoFollowSignedUpdates
		}
	}
	return lim, pl, vp, nil
}

func trustOf(p *api.Project) policy.Trust {
	return policy.Trust{Tier: p.Trust.Tier, MaxTokensPerTask: p.Trust.MaxTokensPerTask, MaxTokensPerDay: p.Trust.MaxTokensPerDay}
}

// decide evaluates the donor policy for a task against current usage.
func (w *Worker) decide(maxTokens int64, repoURL string, trust policy.Trust, g, p policy.Usage, active int, backoff policy.BackoffState) policy.Decision {
	lim, pl, _, err := EffectiveLimits(w.Cfg, w.Project)
	if err != nil {
		return policy.Decision{Code: policy.InvalidTask, Reason: err.Error()}
	}
	d := policy.Evaluate(policy.Input{
		Now: w.now(), Global: lim, Project: pl, GlobalUsage: g, ProjectUsage: p, Active: active,
		BackoffUntil: backoff.Until, Trust: trust, MaxTokens: maxTokens, RepoURL: repoURL,
	})
	if d.Allow && w.SessionBudget > 0 && w.sessionUsed.Load()+maxTokens > w.SessionBudget {
		return policy.Decision{Code: "session-budget", Reason: fmt.Sprintf("reserving %d tokens would exceed this run's --budget (%d used of %d)",
			maxTokens, w.sessionUsed.Load(), w.SessionBudget)}
	}
	return d
}

// Precheck evaluates the policy for a listed task without claiming it. The
// manifest data comes from the server and is advisory; the authoritative
// check happens after verification, against the signed manifest.
func (w *Worker) Precheck(t api.Task, proj *api.Project) policy.Decision {
	st, err := w.Store.Snapshot()
	if err != nil {
		return policy.Decision{Code: policy.InvalidTask, Reason: "cannot read local state: " + err.Error()}
	}
	if delay, _ := w.Cfg.Global.RetryDelay(); delay > 0 {
		if when, status := store.LastFailure(st, w.Ref.Key(), t.TaskID); !when.IsZero() && w.now().Sub(when) < delay {
			wait := delay - w.now().Sub(when)
			return policy.Decision{Code: "recently-failed", RetryAfter: wait,
				Reason: fmt.Sprintf("this task ended %q here %s ago; not retrying for another %s (retry_failed_after)",
					status, w.now().Sub(when).Round(time.Second), wait.Round(time.Minute))}
		}
	}
	g, p, active := store.UsageOf(st, w.now(), w.Ref.Key())
	return w.decide(t.Manifest.MaxTokens, proj.RepoURL, trustOf(proj), g, p, active, st.Backoff)
}

// Prepare negotiates with the instance, resolves the agent credentials and
// checks the container engine. It must succeed before any task is claimed.
func (w *Worker) Prepare(ctx context.Context) (*api.Project, error) {
	meta, err := w.API.Negotiate(ctx, spec.SpecVersion)
	if err != nil {
		return nil, err
	}
	w.meta = meta
	proj, err := w.API.Project(ctx, w.Ref.Slug)
	if err != nil {
		return nil, fmt.Errorf("fetch project %s: %w", w.Ref.Slug, err)
	}
	if _, _, _, err := EffectiveLimits(w.Cfg, w.Project); err != nil {
		return nil, err
	}
	lookup := w.LookupEnv
	if lookup == nil {
		lookup = os.LookupEnv
	}
	creds, err := w.Runner.Credentials(ctx, lookup, w.Cfg.Global.ClaudeTokenCommand, w.Cfg.Global.Sandbox.PassEnv)
	if err != nil {
		return nil, err
	}
	w.creds = creds
	if _, err := sandbox.Available(ctx, w.Engine); err != nil {
		return nil, err
	}
	for _, img := range []string{w.Cfg.Global.Sandbox.Image, w.Cfg.Global.Sandbox.EgressProxyImage} {
		if !sandbox.ImagePresent(ctx, w.Engine, img) {
			return nil, fmt.Errorf("container image %s is not present locally; pull or build it first (see worker/README.md)", img)
		}
	}
	if removed, _ := sandbox.CleanOrphans(ctx, w.Engine, store.PIDAlive); len(removed) > 0 {
		w.say("removed %d orphaned sandbox resource(s) from an earlier run", len(removed))
	}
	if rec, _ := w.Store.RecoverStale(w.now(), store.PIDAlive); len(rec) > 0 {
		w.say("settled %d run(s) left unfinished by an earlier worker process", len(rec))
	}
	if proj.Pubkey != w.Project.Pubkey {
		w.say("note: the server now publishes a different maintainer key than the one you pinned; the worker keeps trusting only your pinned key (and keys it rotated to)")
	}
	return proj, nil
}

func (w *Worker) repoLock(dir string) *sync.Mutex {
	m, _ := w.repoLocks.LoadOrStore(dir, &sync.Mutex{})
	return m.(*sync.Mutex)
}

// egressAllowlist is the model API plus the project's git host plus whatever
// the donor explicitly added. Nothing from the claim or the repository can
// widen it beyond the git host the donor's policy already allowed.
func (w *Worker) egressAllowlist(repoURL string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(h string) {
		h = strings.ToLower(strings.TrimSpace(h))
		if h != "" && !seen[h] {
			seen[h] = true
			out = append(out, h)
		}
	}
	for _, h := range w.Runner.APIHosts() {
		add(h)
	}
	if h, err := policy.GitHostOf(repoURL); err == nil && h != "file" {
		add(h)
	}
	for _, h := range w.Cfg.Global.Sandbox.ExtraAllowHosts {
		add(h)
	}
	return out
}

func short(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func runID(claimID string) string {
	id := strings.ToLower(strings.TrimPrefix(claimID, "clm_"))
	if len(id) > 20 {
		id = id[:20]
	}
	return fmt.Sprintf("%s-%d", id, os.Getpid())
}

// readers shared by plan/tar.
func blobReader(repo string) func(ctx context.Context, oid string) ([]byte, error) {
	return func(ctx context.Context, oid string) ([]byte, error) { return gitx.ReadBlob(ctx, repo, oid) }
}
