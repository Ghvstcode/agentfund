package pipeline

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/spec"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

// LoopOptions control Work.
type LoopOptions struct {
	// Once stops after the first task that was actually claimed (or when nothing is claimable).
	Once bool
	// TaskID restricts work to one manifest id.
	TaskID string
	// Poll is the idle delay between looks at the queue.
	Poll time.Duration
	// OnResult is called for every finished attempt (claimed tasks only).
	OnResult func(Result)
}

// ErrNothingToDo is returned by Work in Once mode when no task could be started.
var ErrNothingToDo = errors.New("no task could be started")

// Work is the main loop: check schedule and budget, list claimable tasks,
// pick the first one that passes policy, run it, repeat. It returns when ctx
// is cancelled (after releasing active claims), on a fatal error, or — in
// Once mode — after one attempt.
func (w *Worker) Work(ctx context.Context, opts LoopOptions) error {
	if opts.Poll <= 0 {
		opts.Poll = 30 * time.Second
	}
	proj, err := w.Prepare(ctx)
	if err != nil {
		return err
	}
	maxc := w.Cfg.Global.MaxConcurrent
	if opts.Once || maxc < 1 {
		maxc = 1
	}
	w.say("working on %s (%s), up to %d task(s) at a time", w.Ref.Key(), proj.RepoURL, maxc)

	var (
		wg       sync.WaitGroup
		mu       sync.Mutex
		fatal    error
		attempts int
		slots    = make(chan struct{}, maxc)
	)
	setFatal := func(err error) {
		mu.Lock()
		if fatal == nil {
			fatal = err
		}
		mu.Unlock()
	}
	getFatal := func() error { mu.Lock(); defer mu.Unlock(); return fatal }
	defer wg.Wait()

	lastWhy := ""
	for {
		if ctx.Err() != nil {
			wg.Wait()
			return getFatal()
		}
		if f := getFatal(); f != nil {
			wg.Wait()
			return f
		}
		wait := opts.Poll
		started := false
		why := ""
		// Honour a 429 Retry-After from the server before asking it anything else.
		if d := w.serverWait(); d > 0 {
			why = fmt.Sprintf("the server asked to slow down (429); waiting %s", d.Round(time.Second))
			wait = d
			goto idle
		}
		// Refresh the project (trust tier and status can change) and the queue.
		if p, perr := w.API.Project(ctx, w.Ref.Slug); perr == nil {
			proj = p
		} else {
			w.noteServerLimit(perr)
		}
		if proj.Status != "active" {
			why = "project is " + proj.Status
		} else {
			var tasks []api.Task
			var terr error
			if opts.TaskID != "" {
				var one *api.Task
				if one, terr = w.API.Task(ctx, w.Ref.Slug+":"+opts.TaskID); terr == nil && one.Claimable {
					tasks = []api.Task{*one}
				} else if terr == nil {
					why = fmt.Sprintf("task %s is %s and not claimable right now", opts.TaskID, one.State)
					if len(one.BlockedBy) > 0 {
						why += fmt.Sprintf(" (blocked by %v)", one.BlockedBy)
					}
				}
			} else {
				tasks, terr = w.API.Tasks(ctx, w.Ref.Slug, true)
			}
			if terr != nil {
				w.noteServerLimit(terr)
				why = "cannot list tasks: " + terr.Error()
			} else if len(tasks) == 0 && why == "" {
				why = "no claimable tasks"
			}
			for _, t := range tasks {
				if opts.TaskID != "" && t.TaskID != opts.TaskID {
					continue
				}
				if _, busy := w.inFlight.Load(t.TaskID); busy {
					continue
				}
				d := w.Precheck(t, proj)
				if d.Allow {
					d = w.approvalCheck(ctx, proj.RepoURL, t.Commit)
				}
				if !d.Allow {
					why = fmt.Sprintf("%s skipped: %s", t.TaskID, d.Reason)
					if d.RetryAfter > 0 && d.RetryAfter < wait {
						wait = d.RetryAfter
					}
					if d.Code == policy.OutsideSchedule || d.Code == policy.Backoff || d.Code == policy.Concurrency ||
						d.Code == policy.DailyCap || d.Code == policy.WeeklyCap || d.Code == "session-budget" || d.Code == CodeNeedsApproval {
						if d.Code == CodeNeedsApproval {
							why = d.Reason
						}
						if d.RetryAfter > wait {
							wait = min(d.RetryAfter, 15*time.Minute)
						}
						if d.Code != "session-budget" {
							break // not task-specific: no later task will pass either
						}
					}
					continue
				}
				select {
				case slots <- struct{}{}:
				default:
					why = "all task slots are busy"
					goto idle
				}
				started = true
				attempts++
				wg.Add(1)
				go func(t api.Task, proj *api.Project) {
					defer wg.Done()
					defer func() { <-slots }()
					res, rerr := w.RunTask(ctx, t, proj)
					if opts.OnResult != nil {
						opts.OnResult(res)
					}
					if res.Outcome == OutcomeSkipped {
						w.say("%s: %s", t.TaskID, res.Reason)
					}
					var f *ErrFatal
					if errors.As(rerr, &f) {
						setFatal(f)
					} else if rerr != nil {
						w.say("%s: %v", t.TaskID, rerr)
					}
				}(t, proj)
				if opts.Once {
					wg.Wait()
					return getFatal()
				}
				break
			}
			if opts.TaskID != "" && why == "" && !started {
				why = "task " + opts.TaskID + " is not claimable right now"
			}
		}
	idle:
		if started {
			// Look again right away: there may be room for another task.
			select {
			case <-ctx.Done():
			case <-time.After(500 * time.Millisecond):
			}
			continue
		}
		if opts.Once {
			wg.Wait()
			if f := getFatal(); f != nil {
				return f
			}
			if why == "" {
				why = "no claimable task passes policy"
			}
			return fmt.Errorf("%w: %s", ErrNothingToDo, why)
		}
		if why != "" && why != lastWhy {
			w.say("idle: %s", why)
			lastWhy = why
		}
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
	}
}

// Preview is one row of `dry-run`.
type Preview struct {
	Task     string
	Title    string
	WouldRun bool
	Why      string // why it is skipped (empty when it would run)
	Manifest *spec.Manifest
	Raw      []byte
	Commit   string
	Basis    string
}

// DryRun returns what the next n tasks would be and why any are skipped. It
// fetches and verifies (so the prompts shown are the signed ones) but never
// claims or executes anything.
func (w *Worker) DryRun(ctx context.Context, n int) ([]Preview, error) {
	if _, err := w.API.Negotiate(ctx, spec.SpecVersion); err != nil {
		return nil, err
	}
	proj, err := w.API.Project(ctx, w.Ref.Slug)
	if err != nil {
		return nil, err
	}
	tasks, err := w.API.Tasks(ctx, w.Ref.Slug, false)
	if err != nil {
		return nil, err
	}
	_, _, vpol, err := EffectiveLimits(w.Cfg, w.Project)
	if err != nil {
		return nil, err
	}
	repoDir := gitx.CachePath(w.ReposDir, proj.RepoURL)
	fetched := false
	var fetchErr error
	var out []Preview
	// Usage as it would evolve if the previewed tasks ran one after another.
	st, err := w.Store.Snapshot()
	if err != nil {
		return nil, err
	}
	extra := int64(0)
	for _, t := range tasks {
		if len(out) >= n {
			break
		}
		if t.State != "open" {
			continue
		}
		pv := Preview{Task: t.TaskID, Title: t.Title, Commit: t.Commit}
		if !t.Claimable {
			pv.Why = "not claimable yet"
			if len(t.BlockedBy) > 0 {
				pv.Why = fmt.Sprintf("blocked by unmerged dependencies %v", t.BlockedBy)
			}
		}
		if proj.Status != "active" && pv.Why == "" {
			pv.Why = "project is " + proj.Status
		}
		if h, ok := policy.HostAllowed(w.Cfg.Global.AllowedGitHosts, proj.RepoURL); !ok {
			pv.Why = fmt.Sprintf("git host %q is not in allowed_git_hosts", h)
			out = append(out, pv)
			continue
		}
		if !fetched {
			fetchErr = gitx.Fetch(ctx, repoDir, proj.RepoURL, t.Commit, w.Project.ApprovedCommit)
			fetched = true
		}
		if fetchErr != nil {
			pv.Why = "cannot fetch the repository: " + fetchErr.Error()
			out = append(out, pv)
			continue
		}
		vres, verr := verify.Task(ctx, verify.Request{
			RepoDir: repoDir, Commit: t.Commit, TaskID: t.TaskID, ContentHash: t.ContentHash,
			Approval: verify.Approval{Pubkey: w.Project.Pubkey, ApprovedCommit: w.Project.ApprovedCommit, ApprovedLockSHA256: w.Project.ApprovedLockSHA256},
			Policy:   vpol,
		})
		if verr != nil {
			pv.Why = verr.Error()
			if verify.IsApprovalError(verr) {
				pv.Why = NeedsApprovalMessage(t.Commit, w.Ref.Key())
			}
			out = append(out, pv)
			continue
		}
		pv.Manifest, pv.Raw, pv.Basis = vres.Manifest, vres.ManifestRaw, string(vres.Basis)
		if pv.Why == "" {
			g, p, active := usageWith(st, w, extra)
			d := w.decide(vres.Manifest.MaxTokens, proj.RepoURL, trustOf(proj), g, p, active, st.Backoff)
			if d.Allow {
				pv.WouldRun = true
				extra += vres.Manifest.MaxTokens
			} else {
				pv.Why = "policy: " + d.Reason
			}
		}
		out = append(out, pv)
	}
	return out, nil
}
