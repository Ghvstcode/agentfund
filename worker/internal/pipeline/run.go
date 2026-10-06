package pipeline

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/app"
	"github.com/agentfund/agentfund/worker/internal/githost"
	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/logs"
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/runner"
	"github.com/agentfund/agentfund/worker/internal/sandbox"
	"github.com/agentfund/agentfund/worker/internal/scope"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

// stop reasons
const (
	stopBudget    = "budget"
	stopTimeout   = "timeout"
	stopClaimLost = "claim-lost"
	stopShutdown  = "shutdown"
)

// run is the state of one claimed task.
type run struct {
	w      *Worker
	claim  *api.Claim
	taskID string // manifest id
	log    *logs.Run
	start  time.Time

	tokensIn, tokensOut atomic.Int64
	cost                atomic.Value // float64
	phase               atomic.Value // string

	mu      sync.Mutex
	session *sandbox.Session
	reason  string
	cancel  context.CancelFunc

	reserved       bool
	maxTokens      int64
	timeoutMinutes int
	proxySeen      int
	phaseMeta      atomic.Value // runnerMeta
	hbDone         chan struct{}
	hbStop         context.CancelFunc
}

func (r *run) setPhase(p string) {
	r.phase.Store(p)
	r.log.Event("phase", map[string]any{"phase": p})
	_ = r.w.Store.Progress(r.claim.ClaimID, r.tokensIn.Load(), r.tokensOut.Load(), p, time.Time{})
}

// stop records why the run is being stopped (first reason wins), kills the
// sandbox and cancels the run context.
func (r *run) stop(reason string) {
	r.mu.Lock()
	if r.reason == "" {
		r.reason = reason
	}
	s, cancel := r.session, r.cancel
	r.mu.Unlock()
	if s != nil {
		s.Kill()
	}
	if cancel != nil {
		cancel()
	}
}

func (r *run) stopReason() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.reason
}

func (r *run) usage() (int64, int64) { return r.tokensIn.Load(), r.tokensOut.Load() }

// heartbeat extends the lease and publishes in-flight usage until stopped.
func (r *run) heartbeat(ctx context.Context) {
	defer close(r.hbDone)
	interval := time.Duration(r.claim.HeartbeatIntervalSeconds) * time.Second
	if interval < time.Second {
		interval = 60 * time.Second
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		in, out := r.usage()
		phase, _ := r.phase.Load().(string)
		hctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		resp, err := r.w.API.Heartbeat(hctx, r.claim.ClaimID, api.HeartbeatRequest{TokensIn: &in, TokensOut: &out, Phase: phase})
		cancel()
		switch {
		case err == nil:
			_ = r.w.Store.Progress(r.claim.ClaimID, in, out, phase, resp.LeaseExpiresAt)
		case api.IsCode(err, api.CodeClaimNotActive, api.CodeNotFound):
			r.log.Event("heartbeat", map[string]any{"error": err.Error(), "action": "abort"})
			r.w.say("%s: the server says the claim is no longer active; aborting the run", r.taskID)
			r.stop(stopClaimLost)
			return
		case ctx.Err() != nil:
			return
		default:
			r.log.Event("heartbeat", map[string]any{"error": err.Error(), "action": "retry"})
		}
	}
}

func (r *run) stopHeartbeat() {
	if r.hbStop != nil {
		r.hbStop()
		<-r.hbDone
		r.hbStop = nil
	}
}

// RunTask claims and runs one task. The returned Result always describes
// what happened; err is non-nil only for conditions the caller must act on
// (ErrFatal) or infrastructure failures before a claim existed.
func (w *Worker) RunTask(ctx context.Context, task api.Task, proj *api.Project) (res Result, err error) {
	res = Result{Task: task.TaskID, Outcome: OutcomeSkipped}
	if _, busy := w.inFlight.LoadOrStore(task.TaskID, struct{}{}); busy {
		res.Reason = "already running in this worker"
		return res, nil
	}
	defer w.inFlight.Delete(task.TaskID)

	claim, cerr := w.API.Claim(ctx, task.ID)
	if cerr != nil {
		if code := api.CodeOf(cerr); code != "" {
			res.Reason = "claim refused: " + code
			return res, nil
		}
		return res, fmt.Errorf("claim %s: %w", task.ID, cerr)
	}
	res.Claim = claim.ClaimID
	w.active.Add(1)
	defer w.active.Add(-1)

	scrub := logs.NewScrubber(w.creds.Secrets)
	lg, lerr := logs.Open(w.LogsDir, claim.ClaimID, w.now(), scrub)
	if lerr != nil {
		_ = w.API.Release(context.WithoutCancel(ctx), claim.ClaimID, api.ReleaseRequest{Reason: "worker cannot write its run log"})
		res.Outcome, res.Reason = OutcomeReleased, "cannot open run log: "+lerr.Error()
		return res, nil
	}
	defer lg.Close()
	res.LogFile = lg.Path()

	r := &run{w: w, claim: claim, taskID: task.TaskID, log: lg, start: w.now(), hbDone: make(chan struct{})}
	r.cost.Store(float64(0))
	r.phase.Store(api.PhaseVerifying)
	lg.Event("claim", map[string]any{
		"claim_id": claim.ClaimID, "task": task.ID, "project": w.Ref.Key(), "repo_url": claim.RepoURL, "commit": claim.Commit,
		"content_hash": claim.ContentHash, "base_branch": claim.BaseBranch, "worker": app.UserAgent(), "runner": w.Runner.Name(),
	})

	runCtx, cancel := context.WithCancel(ctx)
	r.cancel = cancel
	defer cancel()
	hbCtx, hbStop := context.WithCancel(context.WithoutCancel(ctx))
	r.hbStop = hbStop
	go r.heartbeat(hbCtx)
	defer r.stopHeartbeat()

	// Shutdown (signal) → stop the run; the claim is released below.
	shutdownWatch := make(chan struct{})
	defer close(shutdownWatch)
	go func() {
		select {
		case <-ctx.Done():
			r.stop(stopShutdown)
		case <-shutdownWatch:
		}
	}()

	// Whatever happens — including a panic — the sandbox is torn down and the
	// local reservation is settled.
	defer func() {
		if p := recover(); p != nil {
			lg.Event("panic", map[string]any{"panic": fmt.Sprint(p), "stack": string(debug.Stack())})
			r.teardown()
			fin := r.finish(context.WithoutCancel(ctx), api.StatusFailed, "internal worker error", nil, nil)
			res = fin
			err = fmt.Errorf("internal error while running %s: %v", task.ID, p)
			return
		}
		r.teardown()
	}()

	res, err = r.execute(runCtx, ctx, proj)
	return res, err
}

func (r *run) teardown() {
	r.mu.Lock()
	s := r.session
	r.session = nil
	r.mu.Unlock()
	if s != nil {
		s.Close()
	}
}

func (r *run) result(outcome, reason string) Result {
	in, out := r.usage()
	c, _ := r.cost.Load().(float64)
	return Result{Task: r.taskID, Claim: r.claim.ClaimID, Outcome: outcome, Reason: r.log.Scrub(reason), TokensIn: in, TokensOut: out, Cost: c, LogFile: r.log.Path()}
}

func (r *run) settle(status, message string, pub *githost.Published) {
	in, out := r.usage()
	if !r.reserved {
		// Nothing was reserved (refused before the policy step): record the run for `status` only.
		_ = r.w.Store.Reserve(store.Run{Claim: r.claim.ClaimID, Project: r.w.Ref.Key(), Task: r.taskID, PID: os.Getpid()}, r.start,
			func(_, _ policy.Usage, _ int, _ policy.BackoffState) policy.Decision {
				return policy.Decision{Allow: true}
			})
	}
	fin := store.Run{TokensIn: in, TokensOut: out, Status: status, Message: short(r.log.Scrub(message), 300), LogFile: r.log.Path()}
	if pub != nil {
		fin.Branch, fin.PRURL = pub.Branch, pub.PRURL
	}
	_ = r.w.Store.Settle(r.claim.ClaimID, r.w.now(), fin)
	if r.reserved {
		// This invocation's --budget was charged the full reservation; settle it to actual usage.
		r.w.sessionUsed.Add(in + out - r.maxTokens)
	}
}

// finish freezes the log, sends the single report for the claim and records
// the outcome locally.
func (r *run) finish(ctx context.Context, status, message string, verifyExit *int, pub *githost.Published) Result {
	r.stopHeartbeat()
	in, out := r.usage()
	c, _ := r.cost.Load().(float64)
	message = short(r.log.Scrub(message), 1900)
	r.log.Event("outcome", map[string]any{"status": status, "message": message, "tokens_in": in, "tokens_out": out, "cost_estimate": c})
	digest, derr := r.log.Freeze()
	if derr != nil {
		digest = strings.Repeat("0", 64)
	}
	dur := int64(r.w.now().Sub(r.start).Seconds())
	if dur < 0 {
		dur = 0
	}
	rep := api.ReportCreate{
		Status: status, TokensIn: in, TokensOut: out, CostEstimate: c, LogDigest: digest,
		DurationSeconds: &dur, VerifyExitCode: verifyExit, Message: message,
	}
	if meta := r.runnerMeta(); meta.version != "" {
		rep.Runner, rep.Model = short(meta.version, 80), short(meta.model, 80)
	}
	if pub != nil {
		rep.Branch, rep.PRURL, rep.HeadSHA = &pub.Branch, &pub.PRURL, &pub.HeadSHA
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer cancel()
	var (
		resp    *api.Report
		sendErr error
	)
	for attempt := 0; attempt < 3; attempt++ {
		resp, sendErr = r.w.API.Report(rctx, r.claim.ClaimID, rep)
		if sendErr == nil || api.CodeOf(sendErr) != "" {
			break
		}
		time.Sleep(time.Duration(attempt+1) * time.Second)
	}
	side := map[string]any{"claim_id": r.claim.ClaimID, "log_file": r.log.Path(), "log_digest": digest, "report": rep}
	if sendErr != nil {
		side["report_error"] = sendErr.Error()
		r.w.say("%s: could not deliver the report: %v", r.taskID, sendErr)
	} else {
		side["server_response"] = resp
	}
	_ = r.log.WriteSidecar(side)
	r.settle(status, message, pub)

	res := r.result(status, message)
	res.LogDigest = digest
	if pub != nil {
		res.Branch, res.PRURL, res.HeadSHA = pub.Branch, pub.PRURL, pub.HeadSHA
	}
	return res
}

type runnerMeta struct{ version, model string }

func (r *run) runnerMeta() runnerMeta {
	if v, ok := r.phaseMeta.Load().(runnerMeta); ok {
		return v
	}
	return runnerMeta{version: r.w.Runner.Name()}
}

// release gives the claim back (policy refusal, shutdown, rate limit).
func (r *run) release(ctx context.Context, reason string) Result {
	r.stopHeartbeat()
	in, out := r.usage()
	reason = short(r.log.Scrub(reason), 480)
	r.log.Event("outcome", map[string]any{"status": OutcomeReleased, "message": reason, "tokens_in": in, "tokens_out": out})
	digest, _ := r.log.Freeze()
	rel := api.ReleaseRequest{Reason: reason}
	if in+out > 0 {
		rel.TokensIn, rel.TokensOut = &in, &out
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	err := r.w.API.Release(rctx, r.claim.ClaimID, rel)
	side := map[string]any{"claim_id": r.claim.ClaimID, "log_file": r.log.Path(), "log_digest": digest, "release": rel}
	if err != nil {
		side["release_error"] = err.Error()
	}
	_ = r.log.WriteSidecar(side)
	r.settle(store.StatusReleased, reason, nil)
	res := r.result(OutcomeReleased, reason)
	res.LogDigest = digest
	return res
}

// abort ends a run whose claim the server no longer honours: nothing is
// reported (a report would be refused or flagged late); usage is kept locally.
func (r *run) abort(reason string) Result {
	r.stopHeartbeat()
	r.log.Event("outcome", map[string]any{"status": OutcomeAborted, "message": reason})
	digest, _ := r.log.Freeze()
	_ = r.log.WriteSidecar(map[string]any{"claim_id": r.claim.ClaimID, "log_digest": digest, "aborted": reason})
	r.settle(store.StatusAborted, reason, nil)
	res := r.result(OutcomeAborted, reason)
	res.LogDigest = digest
	return res
}

// interrupted maps a stop reason to the right ending. ok is false when the
// run was not stopped.
func (r *run) interrupted(ctx context.Context) (Result, bool) {
	switch r.stopReason() {
	case stopClaimLost:
		return r.abort("the server reported the claim as no longer active"), true
	case stopShutdown:
		return r.release(ctx, "worker is shutting down"), true
	case stopBudget:
		return r.finish(ctx, api.StatusBudgetExceeded, fmt.Sprintf("killed at max_tokens (%d)", r.maxTokens), nil, nil), true
	case stopTimeout:
		return r.finish(ctx, api.StatusTimeout, fmt.Sprintf("killed at timeout_minutes (%d)", r.timeoutMinutes), nil, nil), true
	}
	return Result{}, false
}

func (r *run) execute(ctx, parent context.Context, proj *api.Project) (Result, error) {
	w, claim, lg := r.w, r.claim, r.log
	lim, _, vpol, err := EffectiveLimits(w.Cfg, w.Project)
	if err != nil {
		return r.release(parent, "worker configuration is invalid: "+err.Error()), nil
	}

	// ── Step 5 (early part): the git host must be allowed before anything is fetched.
	if h, ok := policy.HostAllowed(lim.AllowedGitHosts, claim.RepoURL); !ok {
		return r.release(parent, fmt.Sprintf("git host %q is not in allowed_git_hosts", h)), nil
	}
	host, err := w.HostFor(claim.RepoURL)
	if err != nil {
		return r.release(parent, err.Error()), nil
	}

	// ── Steps 1–4: fetch and verify. Nothing from the repo runs before this passes.
	repoDir := gitx.CachePath(w.ReposDir, claim.RepoURL)
	lock := w.repoLock(repoDir)
	lock.Lock()
	ferr := gitx.Fetch(ctx, repoDir, claim.RepoURL, claim.Commit, w.Project.ApprovedCommit)
	lock.Unlock()
	if res, stopped := r.interrupted(parent); stopped {
		return res, nil
	}
	if ferr != nil {
		lg.Event("fetch", map[string]any{"error": ferr.Error()})
		return r.release(parent, "cannot fetch the repository: "+ferr.Error()), nil
	}
	vres, verr := verify.Task(ctx, verify.Request{
		RepoDir: repoDir, Commit: claim.Commit, TaskID: r.taskID, ContentHash: claim.ContentHash,
		Approval: verify.Approval{Pubkey: w.Project.Pubkey, ApprovedCommit: w.Project.ApprovedCommit, ApprovedLockSHA256: w.Project.ApprovedLockSHA256},
		Policy:   vpol,
	})
	if res, stopped := r.interrupted(parent); stopped {
		return res, nil
	}
	if verr != nil {
		if !verify.IsVerificationError(verr) {
			return r.release(parent, "verification could not run: "+verr.Error()), nil
		}
		lg.Event("verification", map[string]any{"ok": false, "error": verr.Error()})
		w.say("%s: REFUSED — %v", r.taskID, verr)
		return r.finish(parent, api.StatusVerificationFailed, verr.Error(), nil, nil), nil
	}
	m := vres.Manifest
	r.maxTokens, r.timeoutMinutes = m.MaxTokens, m.TimeoutMinutes
	lg.Event("verification", map[string]any{
		"ok": true, "basis": string(vres.Basis), "signer_fingerprint": vres.Signer.Fingerprint(), "rotations": vres.Rotations,
		"lock_sha256": vres.LockSHA256, "manifest_path": vres.ManifestPath, "manifest_sha256": claim.ContentHash,
	})
	lg.Event("manifest", map[string]any{"raw": string(vres.ManifestRaw), "parsed": m})
	lg.Event("prompt", map[string]any{"prompt": m.Prompt})

	// ── Step 5: donor policy against the *verified* manifest; reserve max_tokens atomically.
	trust := trustOf(proj)
	rerr := w.Store.Reserve(store.Run{Claim: claim.ClaimID, Project: w.Ref.Key(), Task: r.taskID, Reserved: m.MaxTokens, PID: os.Getpid(), Phase: api.PhaseVerifying, LogFile: lg.Path()},
		w.now(), func(g, p policy.Usage, active int, b policy.BackoffState) policy.Decision {
			return w.decide(m.MaxTokens, claim.RepoURL, trust, g, p, active, b)
		})
	if rerr != nil {
		var refused *store.ErrRefused
		if errors.As(rerr, &refused) {
			lg.Event("policy", map[string]any{"allow": false, "code": string(refused.Decision.Code), "reason": refused.Decision.Reason})
			w.say("%s: policy refuses — %s", r.taskID, refused.Decision.Reason)
			return r.release(parent, "donor policy: "+refused.Decision.Reason), nil
		}
		return r.release(parent, "cannot record the reservation: "+rerr.Error()), nil
	}
	r.reserved = true
	w.sessionUsed.Add(m.MaxTokens)
	lg.Event("policy", map[string]any{"allow": true, "reserved_tokens": m.MaxTokens})

	// ── Sandbox.
	r.setPhase(api.PhaseSandbox)
	entries, err := gitx.LsTree(ctx, repoDir, claim.Commit, "", true)
	if err != nil {
		return r.finish(parent, api.StatusFailed, "cannot list the repository tree: "+err.Error(), nil, nil), nil
	}
	plan, err := scope.NewPlan(ctx, entries, m, blobReader(repoDir))
	if err != nil {
		return r.finish(parent, api.StatusVerificationFailed, "repository tree is not materialisable: "+err.Error(), nil, nil), nil
	}
	allow := w.egressAllowlist(claim.RepoURL)
	sb := w.Cfg.Global.Sandbox
	lg.Event("sandbox", map[string]any{"image": sb.Image, "egress_proxy_image": sb.EgressProxyImage, "egress_allowlist": allow,
		"files": len(plan.Files), "dropped": plan.Dropped, "cpus": sb.CPUs, "memory": sb.Memory, "pids": sb.PIDs})
	session, err := sandbox.Start(ctx, w.Engine, sandbox.Spec{
		RunID: runID(claim.ClaimID), Image: sb.Image, ProxyImage: sb.EgressProxyImage,
		CPUs: sb.CPUs, Memory: sb.Memory, PIDs: sb.PIDs, AllowHosts: allow,
	})
	if err != nil {
		if res, stopped := r.interrupted(parent); stopped {
			return res, nil
		}
		return r.release(parent, "cannot start the sandbox: "+err.Error()), nil
	}
	r.mu.Lock()
	r.session = session
	already := r.reason
	r.mu.Unlock()
	if already != "" {
		res, _ := r.interrupted(parent)
		return res, nil
	}
	pr, pw := io.Pipe()
	go func() { pw.CloseWithError(plan.WriteTar(ctx, pw, blobReader(repoDir))) }()
	if err := session.PutWorkTree(ctx, pr, plan.RootWritable()); err != nil {
		pr.CloseWithError(err)
		if res, stopped := r.interrupted(parent); stopped {
			return res, nil
		}
		return r.release(parent, "cannot populate the sandbox: "+err.Error()), nil
	}

	// ── Agent, under the wall-clock cap that also covers verify.
	deadline := w.now().Add(time.Duration(m.TimeoutMinutes) * time.Minute)
	timer := time.AfterFunc(time.Until(deadline), func() { r.stop(stopTimeout) })
	defer timer.Stop()

	r.setPhase(api.PhaseAgent)
	w.say("%s: running %s in the sandbox (max %d tokens, %d min)", r.taskID, w.Runner.Name(), m.MaxTokens, m.TimeoutMinutes)
	out, runErr := w.Runner.Run(ctx, runner.RunSpec{
		Prompt: m.Prompt, Model: w.Cfg.Global.Runner.Model, Creds: w.creds,
		Exec: func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
			return session.Exec(ctx, sandbox.ExecSpec{Cmd: cmd, PassEnv: pass, Env: env, Stdin: stdin, Stdout: stdout, Stderr: stderr})
		},
		OnEvent:  func(line []byte) { lg.Raw("agent", line) },
		OnStderr: func(line []byte) { lg.Raw("agent_stderr", line) },
		OnUsage: func(u runner.Usage) {
			r.tokensIn.Store(u.TokensIn)
			r.tokensOut.Store(u.TokensOut)
			r.cost.Store(u.CostUSD)
			if u.Total() >= m.MaxTokens {
				r.stop(stopBudget)
			}
		},
	})
	r.tokensIn.Store(out.TokensIn)
	r.tokensOut.Store(out.TokensOut)
	r.cost.Store(out.CostUSD)
	r.phaseMeta.Store(runnerMeta{version: out.Version, model: out.Model})
	lg.Event("agent_exit", map[string]any{"exit_code": out.ExitCode, "result_seen": out.ResultSeen, "is_error": out.IsError, "final_usage": out.Final,
		"tokens_in": out.TokensIn, "tokens_out": out.TokensOut, "cost_estimate": out.CostUSD, "model": out.Model, "runner": out.Version,
		"rate_limited": out.RateLimited, "message": out.Message})
	r.proxyLog(session)

	if out.Total() > m.MaxTokens {
		r.stop(stopBudget)
	}
	if res, stopped := r.interrupted(parent); stopped {
		return res, nil
	}
	switch {
	case out.CredentialProblem != "":
		res := r.release(parent, "the model provider rejected the donor's credentials or account ("+out.CredentialProblem+")")
		return res, &ErrFatal{Err: fmt.Errorf("the model provider rejected your credentials or account (%s); fix them and start the worker again", out.CredentialProblem)}
	case out.RateLimited:
		st, _ := w.Store.Snapshot()
		var prev policy.BackoffState
		if st != nil {
			prev = st.Backoff
		}
		next := policy.NextBackoff(prev, w.now(), out.ResetAt, policy.Jitter())
		_ = w.Store.SetBackoff(next)
		w.say("%s: rate limited (%s); releasing the claim and backing off until %s", r.taskID, out.Message, next.Until.Format("15:04:05"))
		return r.release(parent, "rate limited by the model provider: "+out.Message), nil
	case runErr != nil:
		return r.finish(parent, api.StatusFailed, "sandbox error while running the agent: "+runErr.Error(), nil, nil), nil
	case out.IsError || out.ExitCode != 0 || !out.ResultSeen:
		msg := out.Message
		if msg == "" {
			msg = fmt.Sprintf("agent exited with code %d without a successful result", out.ExitCode)
		}
		return r.finish(parent, api.StatusFailed, "agent failed: "+msg, nil, nil), nil
	}
	// A clean agent run ends any earlier rate-limit backoff.
	_ = w.Store.SetBackoff(policy.BackoffState{})

	// ── Verify, still inside the restricted sandbox.
	r.setPhase(api.PhaseVerify)
	tail := logs.NewTail(256 << 10)
	code, vErr := session.Exec(ctx, sandbox.ExecSpec{Cmd: []string{"sh", "-c", m.Verify}, Stdout: tail, Stderr: tail})
	lg.Event("verify", map[string]any{"command": m.Verify, "exit_code": code, "output": tail.String(), "error": errString(vErr)})
	timer.Stop() // timeout_minutes covers agent + verify; scope check and publishing are the worker's own time
	r.proxyLog(session)
	if res, stopped := r.interrupted(parent); stopped {
		return res, nil
	}
	if vErr != nil {
		return r.finish(parent, api.StatusFailed, "sandbox error while running verify: "+vErr.Error(), nil, nil), nil
	}
	if code != 0 {
		w.say("%s: verify exited %d", r.taskID, code)
		return r.finish(parent, api.StatusFailed, fmt.Sprintf("verify command exited with code %d", code), &code, nil), nil
	}

	// ── Scope check: read the working tree as data, never extract it.
	ic, err := gitx.NewIgnoreChecker(ctx, repoDir, claim.Commit)
	if err != nil {
		return r.finish(parent, api.StatusFailed, "cannot prepare ignore rules: "+err.Error(), &code, nil), nil
	}
	defer ic.Close()
	tarStream, wait := session.TarWorkTree(ctx)
	changes, derr := scope.Diff(tarStream, sandbox.WorkRoot, plan, func(paths []string) (map[string]bool, error) { return ic.Ignored(ctx, paths) }, w.limits())
	_, _ = io.Copy(io.Discard, tarStream)
	tarStream.Close()
	werr := wait()
	if res, stopped := r.interrupted(parent); stopped {
		return res, nil
	}
	if derr != nil {
		if scope.IsViolation(derr) {
			lg.Event("scope", map[string]any{"ok": false, "violation": derr.Error()})
			w.say("%s: DISCARDED — %v", r.taskID, derr)
			return r.finish(parent, api.StatusVerificationFailed, derr.Error(), &code, nil), nil
		}
		return r.finish(parent, api.StatusFailed, "scope check could not run: "+derr.Error(), &code, nil), nil
	}
	if werr != nil {
		return r.finish(parent, api.StatusFailed, "cannot read the sandbox working tree: "+werr.Error(), &code, nil), nil
	}
	// A change set that carries the donor's credential must never be published.
	for _, c := range changes {
		for _, secret := range w.creds.Secrets {
			if secret != "" && (bytes.Contains(c.Content, []byte(secret)) || strings.Contains(c.Path, secret)) {
				lg.Event("scope", map[string]any{"ok": false, "violation": "credential found in " + c.Path})
				w.say("%s: DISCARDED — the change to %s contains your agent credential", r.taskID, c.Path)
				return r.finish(parent, api.StatusVerificationFailed, "the change set contains the donor's agent credential ("+c.Path+"); run discarded", &code, nil), nil
			}
		}
	}
	lg.Event("scope", map[string]any{"ok": true, "changes": scope.Summary(changes)})
	for _, c := range changes {
		lg.Event("diff", map[string]any{"path": c.Path, "kind": string(c.Kind), "mode": c.Mode, "content": string(c.Content)})
	}
	if len(changes) == 0 {
		return r.finish(parent, api.StatusFailed, "the agent changed nothing inside scope.write", &code, nil), nil
	}
	// The sandbox has served its purpose.
	r.teardown()

	// ── Publish: built on the host from data; credentials never entered the sandbox.
	r.setPhase(api.PhasePushing)
	branch, err := githost.BranchName(r.taskID, claim.ClaimID)
	if err != nil {
		return r.finish(parent, api.StatusFailed, err.Error(), &code, nil), nil
	}
	var tree []gitx.TreeChange
	for _, c := range changes {
		tree = append(tree, gitx.TreeChange{Path: c.Path, Delete: c.Kind == scope.Deleted, Mode: c.Mode, Content: c.Content})
	}
	taskRef := w.Ref.Slug + ":" + r.taskID
	in, outTok := r.usage()
	preDigest, _ := logs.DigestFile(lg.Path())
	body := fmt.Sprintf("Automated change produced by an %s worker run.\n\n"+
		"| | |\n|---|---|\n| Task | `%s` — %s |\n| Claim | `%s` |\n| Manifest SHA-256 | `%s` |\n| Base commit | `%s` |\n"+
		"| Tokens | %d in / %d out |\n| Runner | %s |\n| Verify | `%s` exited 0 in the sandbox |\n| Worker log digest (at push) | `%s` |\n\n"+
		"Changed paths (all inside the manifest's `scope.write`):\n\n```\n%s```\n",
		app.AppName, taskRef, m.Title, claim.ClaimID, claim.ContentHash, claim.Commit, in, outTok, out.Version, short(m.Verify, 200), preDigest, scope.Summary(changes))
	lg.Event("publish", map[string]any{"host": host.Name(), "branch": branch, "base_branch": claim.BaseBranch, "log_digest_at_push": preDigest})
	pub, perr := host.Publish(ctx, githost.Request{
		RepoDir: repoDir, RepoURL: claim.RepoURL, BaseBranch: claim.BaseBranch, BaseCommit: claim.Commit, Branch: branch,
		Changes: tree, Title: m.Title + " (" + r.taskID + ")", Body: lg.Scrub(body),
		Message: githost.CommitMessage(m.Title, taskRef, claim.ClaimID, claim.ContentHash),
	})
	if res, stopped := r.interrupted(parent); stopped && perr != nil {
		return res, nil
	}
	if perr != nil {
		lg.Event("publish", map[string]any{"error": perr.Error()})
		return r.finish(parent, api.StatusFailed, "could not publish the branch: "+perr.Error(), &code, nil), nil
	}
	lg.Event("published", map[string]any{"branch": pub.Branch, "pr_url": pub.PRURL, "head_sha": pub.HeadSHA})
	w.say("%s: completed — %s", r.taskID, pub.PRURL)
	return r.finish(parent, api.StatusCompleted, "", &code, &pub), nil
}

func (r *run) proxyLog(s *sandbox.Session) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	lines, err := s.ProxyLogs(ctx)
	if err != nil {
		return
	}
	for _, l := range lines[min(r.proxySeen, len(lines)):] {
		r.log.Raw("egress", []byte(l))
	}
	r.proxySeen = len(lines)
}

func (w *Worker) limits() scope.Limits {
	if w.Limits.MaxFileBytes > 0 {
		return w.Limits
	}
	return scope.DefaultLimits
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
