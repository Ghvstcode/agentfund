package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/app"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/githost"
	"github.com/agentfund/agentfund/worker/internal/pipeline"
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/runner"
	"github.com/agentfund/agentfund/worker/internal/sandbox"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/tokfmt"
)

// Environment overrides for images (handy for local builds and end-to-end tests).
const (
	EnvSandboxImage = app.EnvPrefix + "_SANDBOX_IMAGE"
	EnvProxyImage   = app.EnvPrefix + "_EGRESS_PROXY_IMAGE"
)

func newWorker(e *env, arg string, needKey bool) (*pipeline.Worker, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, err
	}
	ref, proj, err := cfg.Resolve(arg)
	if err != nil {
		return nil, err
	}
	if v := os.Getenv(EnvSandboxImage); v != "" {
		cfg.Global.Sandbox.Image = v
	}
	if v := os.Getenv(EnvProxyImage); v != "" {
		cfg.Global.Sandbox.EgressProxyImage = v
	}
	key := ""
	if needKey {
		if key, err = config.APIKey(ref.Server, proj); err != nil {
			return nil, err
		}
	} else {
		key, _ = config.APIKey(ref.Server, proj)
	}
	return &pipeline.Worker{
		Cfg: cfg, Ref: ref, Project: proj,
		API:      api.New(ref.Server, key),
		Store:    store.Open(config.StorePath()),
		Engine:   sandbox.CLI{Bin: cfg.Global.Sandbox.Docker},
		Runner:   runner.NewClaudeCode(),
		HostFor:  githost.For,
		ReposDir: config.ReposDir(), LogsDir: config.LogsDir(),
		Out: e.err,
	}, nil
}

func workCmd(e *env) *cobra.Command {
	var budget, schedule, taskID, sandboxImage, proxyImage string
	var maxConcurrent int
	var once, jsonOut bool
	var poll time.Duration
	cmd := &cobra.Command{
		Use:   "work <project>",
		Short: "Claim and run tasks of an approved project",
		Long: `Loop: check schedule and budget → list claimable tasks → pick the first one
that passes your policy → claim → verify signature, hashes and approval →
run the agent in the sandbox → run verify → scope-check the diff → push the
branch and open the PR → report. Ctrl-C (SIGINT/SIGTERM) stops the sandbox
and releases active claims.

<project> is <server-url>/<slug> or a slug that is unique in your config.

The coding agent runs under YOUR credentials, read from the environment at
run time: CLAUDE_CODE_OAUTH_TOKEN (from ` + "`claude setup-token`" + `) and/or
ANTHROPIC_API_KEY, or the claude_token_command in config.yaml. They are passed
to the sandboxed agent process and are never stored or sent anywhere else.

Exit status:
  0    stopped normally; with --once: a task completed and its report was accepted
  1    error (configuration, credentials, server, Docker, images)
  2    usage error (unknown command or flag, bad flag value)
  3    --once: nothing could be started (nothing claimable, your policy refuses,
       or the project moved past your approval)
  4    --once: a task was claimed but did not complete, or the server did not
       accept its report (see the --json line, the report sidecar and the log)
  130  --once: interrupted (Ctrl-C) before a task completed`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			w, err := newWorker(e, args[0], true)
			if err != nil {
				return err
			}
			if budget != "" {
				b, err := config.ParseTokens(budget)
				if err != nil {
					return exitWith(ExitUsage, "--budget: %v", err)
				}
				w.SessionBudget = int64(b)
			}
			if cmd.Flags().Changed("schedule") {
				var windows []string
				for _, s := range strings.Split(schedule, ",") {
					if s = strings.TrimSpace(s); s != "" {
						windows = append(windows, s)
					}
				}
				if _, err := policy.ParseSchedule(windows); err != nil {
					return exitWith(ExitUsage, "--schedule: %v", err)
				}
				w.Cfg.Global.Schedule = windows
				w.Project.Schedule = nil
			}
			if cmd.Flags().Changed("max-concurrent") {
				if maxConcurrent < 1 || maxConcurrent > 16 {
					return exitWith(ExitUsage, "--max-concurrent must be between 1 and 16")
				}
				w.Cfg.Global.MaxConcurrent = maxConcurrent
			}
			if sandboxImage != "" {
				w.Cfg.Global.Sandbox.Image = sandboxImage
			}
			if proxyImage != "" {
				w.Cfg.Global.Sandbox.EgressProxyImage = proxyImage
			}

			ctx, cancel := signalContext()
			defer cancel()
			var results []pipeline.Result
			opts := pipeline.LoopOptions{Once: once, TaskID: taskID, Poll: poll, OnResult: func(r pipeline.Result) {
				results = append(results, r)
				if jsonOut {
					b, _ := json.Marshal(r)
					fmt.Fprintln(e.out, string(b))
				} else if r.Outcome != pipeline.OutcomeSkipped {
					fmt.Fprintln(e.out, resultLine(r))
					if r.ReportAccepted != nil && !*r.ReportAccepted {
						fmt.Fprintf(e.out, "%s: THE SERVER DID NOT ACCEPT THE REPORT: %s\n", r.Task, r.ReportError)
					}
				}
			}}
			err = w.Work(ctx, opts)
			if errors.Is(err, pipeline.ErrNothingToDo) {
				return exitWith(ExitNothing, "%v", err)
			}
			if err != nil {
				return err
			}
			if ctx.Err() != nil && !once {
				fmt.Fprintln(e.err, "stopped; active claims were released")
				return nil
			}
			if once {
				for _, r := range results {
					if r.Outcome == api.StatusCompleted && r.ReportAccepted != nil && *r.ReportAccepted {
						return nil
					}
					if r.ReportAccepted != nil && !*r.ReportAccepted {
						return exitWith(ExitNotDone, "the server did not accept the report for %s: %s", r.Task, r.ReportError)
					}
				}
				if ctx.Err() != nil {
					return exitWith(ExitInterrupt, "interrupted")
				}
				return exitWith(ExitNotDone, "no task completed")
			}
			return nil
		},
	}
	f := cmd.Flags()
	f.StringVar(&budget, "budget", "", "a further limit for this invocation, e.g. 200m, 5M, 750k; config caps still apply")
	f.StringVar(&schedule, "schedule", "", `local-time windows for this invocation, e.g. "02:00-06:00" or "22:00-06:00,12:00-13:00"; "" = any time`)
	f.IntVar(&maxConcurrent, "max-concurrent", 1, "tasks to run at once (overrides config for this invocation)")
	f.BoolVar(&once, "once", false, "run at most one task, then exit")
	f.StringVar(&taskID, "task", "", "only work on this manifest id (e.g. 0001-slugify)")
	f.BoolVar(&jsonOut, "json", false, "print one JSON object per finished attempt on stdout")
	f.DurationVar(&poll, "poll", 30*time.Second, "idle delay between looks at the queue")
	f.StringVar(&sandboxImage, "sandbox-image", "", "sandbox image for this invocation (also $"+EnvSandboxImage+")")
	f.StringVar(&proxyImage, "egress-proxy-image", "", "egress proxy image for this invocation (also $"+EnvProxyImage+")")
	return cmd
}

// resultLine is the one human-readable line printed for a finished attempt.
func resultLine(r pipeline.Result) string {
	line := fmt.Sprintf("%s: %s (%s in / %s out tokens)", r.Task, r.Outcome, tokfmt.Exact(r.TokensIn), tokfmt.Exact(r.TokensOut))
	if r.Reason != "" {
		line += " — " + r.Reason
	}
	switch {
	case r.PRURL == "":
	case strings.HasPrefix(r.PRURL, "file://"):
		// The local publisher has no pull requests: the branch is pushed straight to the repository.
		repo, _, _ := strings.Cut(r.PRURL, "#")
		line += fmt.Sprintf(" — branch %s pushed to %s", r.Branch, repo)
	default:
		line += " → " + r.PRURL
	}
	return line
}

func dryRunCmd(e *env) *cobra.Command {
	var n int
	cmd := &cobra.Command{
		Use:   "dry-run <project>",
		Short: "Show the next tasks that would run, with full prompts, and why any are skipped",
		Long: `Fetch and verify exactly like work does, evaluate your policy, and print the
next N open tasks: whether each would run, the reason when it would not, and
the full signed manifest. Nothing is claimed and nothing is executed.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if n < 1 {
				return exitWith(ExitUsage, "-n must be at least 1")
			}
			w, err := newWorker(e, args[0], false)
			if err != nil {
				return err
			}
			ctx, cancel := signalContext()
			defer cancel()
			previews, err := w.DryRun(ctx, n)
			if err != nil {
				return err
			}
			if len(previews) == 0 {
				fmt.Fprintln(e.out, "no open tasks")
				return nil
			}
			would := 0
			for i, p := range previews {
				if p.WouldRun {
					would++
					fmt.Fprintf(e.out, "%d. %s — WOULD RUN (commit %s, approval: %s)\n", i+1, p.Task, short12(p.Commit), p.Basis)
				} else {
					fmt.Fprintf(e.out, "%d. %s — SKIPPED: %s\n", i+1, p.Task, p.Why)
				}
				if p.Manifest != nil {
					renderManifest(e.out, p.Manifest, hashOf(p.Raw))
				} else {
					fmt.Fprintf(e.out, "   (manifest not shown: it did not verify)\n\n")
				}
			}
			fmt.Fprintf(e.out, "%d of %d task(s) would run. No claims were made; nothing was executed.\n", would, len(previews))
			return nil
		},
	}
	cmd.Flags().IntVarP(&n, "count", "n", 5, "how many tasks to preview")
	return cmd
}

func short12(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}
