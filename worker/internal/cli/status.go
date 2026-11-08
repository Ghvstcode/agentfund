package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/app"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/lockfile"
	"github.com/agentfund/agentfund/worker/internal/logs"
	"github.com/agentfund/agentfund/worker/internal/pipeline"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/tokfmt"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

func hashOf(b []byte) string { return lockfile.SHA256Hex(b) }

func capText(used int64, limit config.Tokens) string {
	if limit == 0 {
		return fmt.Sprintf("%s (no cap)", tokfmt.Exact(used))
	}
	return fmt.Sprintf("%s of %s (%d%%)", tokfmt.Exact(used), limit, used*100/int64(limit))
}

func statusCmd(e *env) *cobra.Command {
	var jsonOut bool
	var recent int
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Current and recent runs, tokens spent vs caps, lease states",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			st, err := store.Open(config.StorePath()).Snapshot()
			if err != nil {
				return err
			}
			now := time.Now()
			global, _, active := store.UsageOf(st, now, "")

			// Lease states as the servers see them.
			type remote struct {
				Server string             `json:"server"`
				Claims []api.ClaimSummary `json:"claims,omitempty"`
				Error  string             `json:"error,omitempty"`
			}
			var remotes []remote
			seen := map[string]bool{}
			keys := make([]string, 0, len(cfg.Projects))
			for k := range cfg.Projects {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				p := cfg.Projects[k]
				if seen[p.Server] {
					continue
				}
				seen[p.Server] = true
				key, kerr := config.APIKey(p.Server, p)
				if kerr != nil {
					remotes = append(remotes, remote{Server: p.Server, Error: kerr.Error()})
					continue
				}
				ctx, cancel := context.WithTimeout(cmd.Context(), 15*time.Second)
				claims, cerr := api.New(p.Server, key).MyClaims(ctx, true)
				cancel()
				r := remote{Server: p.Server, Claims: claims}
				if cerr != nil {
					r.Error = cerr.Error()
				}
				remotes = append(remotes, r)
			}

			if jsonOut {
				needs := map[string]string{}
				for _, k := range keys {
					if note, must := approvalNote(cmd.Context(), cfg, cfg.Projects[k]); must {
						needs[k] = note
					}
				}
				out := map[string]any{
					"needs_approval": needs,
					"tokens_today":   global.Day, "tokens_this_week": global.Week, "tokens_per_day": int64(cfg.Global.TokensPerDay),
					"tokens_per_week": int64(cfg.Global.TokensPerWeek), "active": active, "backoff_until": st.Backoff.Until, "runs": st.Runs, "servers": remotes,
				}
				enc := json.NewEncoder(e.out)
				enc.SetIndent("", "  ")
				return enc.Encode(out)
			}

			fmt.Fprintf(e.out, "Tokens today:     %s\nTokens this week: %s\n", capText(global.Day, cfg.Global.TokensPerDay), capText(global.Week, cfg.Global.TokensPerWeek))
			fmt.Fprintf(e.out, "(running tasks count at their full max_tokens reservation until they finish)\n")
			if st.Backoff.Until.After(now) {
				fmt.Fprintf(e.out, "Rate-limit backoff until %s (%d consecutive)\n", st.Backoff.Until.Format("Mon 15:04:05"), st.Backoff.Attempts)
			}
			for _, k := range keys {
				p := cfg.Projects[k]
				_, pu, _ := store.UsageOf(st, now, k)
				line := fmt.Sprintf("  %s: today %s, week %s; approved %s", k, tokfmt.Exact(pu.Day), tokfmt.Exact(pu.Week), short12(p.ApprovedCommit))
				if p.TokensPerDay != nil {
					line += fmt.Sprintf(" (project cap/day %s)", *p.TokensPerDay)
				}
				fmt.Fprintln(e.out, line)
				if note, needs := approvalNote(cmd.Context(), cfg, p); note != "" {
					fmt.Fprintf(e.out, "    %s %s\n", map[bool]string{true: "!", false: "·"}[needs], note)
				}
			}

			tw := tabwriter.NewWriter(e.out, 0, 4, 2, ' ', 0)
			var running, done []store.Run
			for _, r := range st.Runs {
				if r.Settled {
					done = append(done, r)
				} else {
					running = append(running, r)
				}
			}
			fmt.Fprintf(e.out, "\nRunning (%d):\n", len(running))
			if len(running) > 0 {
				fmt.Fprintln(tw, "  TASK\tCLAIM\tPHASE\tTOKENS\tRESERVED\tSTARTED\tLEASE UNTIL")
				for _, r := range running {
					lease := "-"
					if !r.Lease.IsZero() {
						lease = r.Lease.Local().Format("15:04:05")
					}
					fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\t%s\n", r.Task, r.Claim, r.Phase, tokfmt.Exact(r.TokensIn+r.TokensOut), tokfmt.Format(r.Reserved), r.Started.Local().Format("15:04:05"), lease)
				}
				tw.Flush()
			}
			sort.Slice(done, func(i, j int) bool { return done[i].Started.After(done[j].Started) })
			if len(done) > recent {
				done = done[:recent]
			}
			fmt.Fprintf(e.out, "\nRecent (%d):\n", len(done))
			if len(done) > 0 {
				fmt.Fprintln(tw, "  WHEN\tTASK\tSTATUS\tTOKENS\tCLAIM\tDETAIL")
				for _, r := range done {
					detail := r.PRURL
					if strings.HasPrefix(detail, "file://") {
						repo, _, _ := strings.Cut(detail, "#")
						detail = "branch " + r.Branch + " pushed to " + repo
					}
					if detail == "" || strings.HasPrefix(r.Message, "REPORT NOT ACCEPTED") {
						detail = r.Message
					}
					if len(detail) > 70 {
						detail = detail[:70] + "…"
					}
					fmt.Fprintf(tw, "  %s\t%s\t%s\t%s\t%s\t%s\n", r.Started.Local().Format("Jan 02 15:04"), r.Task, r.Status, tokfmt.Exact(r.TokensIn+r.TokensOut), r.Claim, detail)
				}
				tw.Flush()
			}
			fmt.Fprintf(e.out, "\nActive claims according to the server(s):\n")
			if len(remotes) == 0 {
				fmt.Fprintln(e.out, "  (no approved projects)")
			}
			for _, r := range remotes {
				if r.Error != "" {
					fmt.Fprintf(e.out, "  %s: %s\n", r.Server, r.Error)
					continue
				}
				if len(r.Claims) == 0 {
					fmt.Fprintf(e.out, "  %s: none\n", r.Server)
				}
				for _, c := range r.Claims {
					fmt.Fprintf(e.out, "  %s: %s %s %s, lease until %s\n", r.Server, c.ClaimID, c.TaskID, c.Status, c.LeaseExpiresAt.Local().Format("15:04:05"))
				}
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&jsonOut, "json", false, "machine-readable output")
	cmd.Flags().IntVar(&recent, "recent", 10, "how many finished runs to list")
	return cmd
}

// approvalNote asks the server where the project is pinned and describes how
// that commit relates to the donor's approval: "" when it is the approved
// commit (or nothing can be said), a "covered by …" note when a follow
// policy or ancestry covers it, the re-approve message when it does not, and
// a hedge when the repository could not be fetched. needs is true only when
// re-approval is definitely required.
func approvalNote(ctx context.Context, cfg *config.Config, p *config.Project) (note string, needs bool) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	proj, err := api.New(p.Server, "").Project(ctx, p.Slug)
	if err != nil || proj.PinnedCommit == p.ApprovedCommit {
		return "", false
	}
	ref := config.Ref{Server: p.Server, Slug: p.Slug}
	basis, ok, why, err := pipeline.ApprovalBasis(ctx, cfg, p, ref, config.ReposDir(), proj.RepoURL, proj.PinnedCommit, false)
	if errors.Is(err, pipeline.ErrCommitNotFetched) {
		basis, ok, why, err = pipeline.ApprovalBasis(ctx, cfg, p, ref, config.ReposDir(), proj.RepoURL, proj.PinnedCommit, true)
	}
	switch {
	case err != nil:
		return fmt.Sprintf("project is now at %s, which may need re-approval; `%s dry-run %s` checks", short12(proj.PinnedCommit), app.BinaryName, p.Slug), false
	case !ok:
		return why, true
	}
	switch basis {
	case verify.BasisUnchangedLock:
		return fmt.Sprintf("project is now at %s — covered by follow_unchanged_lock (the task list is byte-identical to the one you approved)", short12(proj.PinnedCommit)), false
	case verify.BasisAutoFollow:
		return fmt.Sprintf("project is now at %s — covered by auto_follow_signed_updates", short12(proj.PinnedCommit)), false
	case verify.BasisAncestor:
		return fmt.Sprintf("project is at %s, an ancestor of the commit you approved", short12(proj.PinnedCommit)), false
	}
	return "", false
}

func logsCmd(e *env) *cobra.Command {
	var pathOnly, report bool
	cmd := &cobra.Command{
		Use:   "logs [claim]",
		Short: "List run logs, or print the log of one claim",
		Long: `Without an argument, list run logs (newest first). With a claim id (or a
unique part of one), print that run's JSON-lines log: the full prompt, the
manifest, every agent stream event, verify output, the diff, egress proxy
decisions and the outcome. --report prints the sidecar holding the log
digest and the report that was sent.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			dir := config.LogsDir()
			if len(args) == 0 {
				all, err := logs.List(dir)
				if err != nil {
					return err
				}
				if len(all) == 0 {
					fmt.Fprintf(e.out, "no run logs under %s\n", dir)
					return nil
				}
				for _, l := range all {
					fmt.Fprintf(e.out, "%s  %s  %s\n", l.Mod.Local().Format("2006-01-02 15:04:05"), l.Claim, l.Path)
				}
				return nil
			}
			entry, err := logs.Find(dir, args[0])
			if err != nil {
				return err
			}
			p := entry.Path
			if report {
				p = logs.SidecarPath(p)
			}
			if pathOnly {
				fmt.Fprintln(e.out, p)
				return nil
			}
			f, err := os.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			_, err = io.Copy(e.out, f)
			return err
		},
	}
	cmd.Flags().BoolVar(&pathOnly, "path", false, "print the file path instead of its content")
	cmd.Flags().BoolVar(&report, "report", false, "show the report sidecar (digest + report sent) instead of the log")
	return cmd
}

func daemonCmd(e *env) *cobra.Command {
	root := &cobra.Command{Use: "daemon", Short: "Run the worker as a background service"}
	var project string
	var uninstall, now bool
	install := &cobra.Command{
		Use:   "install",
		Short: "Write a systemd user unit (Linux) or launchd agent (macOS) that runs `work`",
		Long: `Write a service definition that runs "` + app.BinaryName + ` work <project>" in the
background, and print how to enable it. Nothing is started unless --now is
given. Remove it again with "` + app.BinaryName + ` daemon uninstall".

The service needs your coding-agent credentials at run time. This tool never
stores them: on Linux the unit reads an optional environment file you create
yourself (~/.config/` + app.BinaryName + `/worker.env, mode 0600); on macOS set
claude_token_command in config.yaml (for example a ` + "`security find-generic-password`" + `
call that reads the token from your keychain).`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			if project == "" {
				if len(cfg.Projects) != 1 {
					return exitWith(ExitUsage, "--project is required (you have %d approved projects)", len(cfg.Projects))
				}
				for _, p := range cfg.Projects {
					project = p.Server + "/" + p.Slug
				}
			}
			ref, _, err := cfg.Resolve(project)
			if err != nil {
				return err
			}
			exe, err := os.Executable()
			if err != nil {
				return err
			}
			if resolved, err := filepath.EvalSymlinks(exe); err == nil {
				exe = resolved
			}
			home, _ := os.UserHomeDir()
			switch runtime.GOOS {
			case "linux":
				unit := app.BinaryName + "-" + ref.Slug + ".service"
				path := filepath.Join(home, ".config", "systemd", "user", unit)
				if uninstall {
					if now {
						_ = exec.Command("systemctl", "--user", "disable", "--now", unit).Run()
					}
					if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
						return err
					}
					fmt.Fprintf(e.out, "removed %s\nRun: systemctl --user daemon-reload\n", path)
					return nil
				}
				content := systemdUnit(exe, ref.Key())
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
					return err
				}
				fmt.Fprintf(e.out, "wrote %s\n", path)
				if now {
					for _, c := range [][]string{{"--user", "daemon-reload"}, {"--user", "enable", "--now", unit}} {
						if out, err := exec.Command("systemctl", c...).CombinedOutput(); err != nil {
							return fmt.Errorf("systemctl %s: %v: %s", strings.Join(c, " "), err, out)
						}
					}
					fmt.Fprintf(e.out, "enabled and started %s\n", unit)
					return nil
				}
				fmt.Fprintf(e.out, "Not started. To enable:\n  systemctl --user daemon-reload\n  systemctl --user enable --now %s\n  journalctl --user -u %s -f\n"+
					"To keep it running while you are logged out: loginctl enable-linger $USER\n"+
					"Credentials: put %s (and %s=af_… if you do not use `login`) in\n  %s (chmod 600), or set %s in %s.\n",
					unit, unit, agentEnvHint(cfg.Global.Runner.Name), config.EnvAPIKey, filepath.Join(config.Dir(), "worker.env"), tokenCommandKey(cfg.Global.Runner.Name), config.Path())
			case "darwin":
				label := "dev." + app.BinaryName + ".worker." + ref.Slug
				path := filepath.Join(home, "Library", "LaunchAgents", label+".plist")
				if uninstall {
					if now {
						_ = exec.Command("launchctl", "unload", path).Run()
					}
					if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
						return err
					}
					fmt.Fprintf(e.out, "removed %s\n", path)
					return nil
				}
				logDir := filepath.Join(config.DataDir(), "daemon")
				if err := os.MkdirAll(logDir, 0o700); err != nil {
					return err
				}
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					return err
				}
				if err := os.WriteFile(path, []byte(launchdPlist(label, exe, ref.Key(), logDir)), 0o644); err != nil {
					return err
				}
				fmt.Fprintf(e.out, "wrote %s\n", path)
				if now {
					if out, err := exec.Command("launchctl", "load", "-w", path).CombinedOutput(); err != nil {
						return fmt.Errorf("launchctl load: %v: %s", err, out)
					}
					fmt.Fprintf(e.out, "loaded %s\n", label)
					return nil
				}
				fmt.Fprintf(e.out, "Not started. To enable:\n  launchctl load -w %s\n  tail -f %s\n"+
					"Credentials: launchd does not inherit your shell environment. Set %s in %s\n"+
					"(e.g. `security find-generic-password -s %s-agent-token -w`) and store the server key with `%s login`.\n",
					path, filepath.Join(logDir, "worker.log"), tokenCommandKey(cfg.Global.Runner.Name), config.Path(), app.BinaryName, app.BinaryName)
			default:
				return fmt.Errorf("daemon install supports linux (systemd) and darwin (launchd), not %s", runtime.GOOS)
			}
			return nil
		},
	}
	install.Flags().StringVar(&project, "project", "", "project to work on (<server-url>/<slug> or unique slug)")
	install.Flags().BoolVar(&uninstall, "uninstall", false, "remove the service definition (same as `daemon uninstall`)")
	_ = install.Flags().MarkHidden("uninstall")
	install.Flags().BoolVar(&now, "now", false, "also enable and start the service")
	remove := &cobra.Command{
		Use:   "uninstall",
		Short: "Remove the service definition written by `daemon install`",
		Long: `Remove the systemd user unit (Linux) or launchd agent (macOS) that
"` + app.BinaryName + ` daemon install" wrote for a project. With --now the service is
also stopped and disabled first; without it, stop it yourself or it keeps
running until the next logout/reboot.`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			uninstall = true
			return install.RunE(cmd, args)
		},
	}
	remove.Flags().StringVar(&project, "project", "", "project whose service to remove (<server-url>/<slug> or unique slug)")
	remove.Flags().BoolVar(&now, "now", false, "also stop and disable the running service")
	root.AddCommand(install, remove)
	return root
}

func passthroughEnv() []string {
	var out []string
	for _, n := range []string{config.EnvConfigDir, config.EnvDataDir} {
		if v := os.Getenv(n); v != "" {
			out = append(out, n+"="+v)
		}
	}
	return out
}

func systemdUnit(exe, project string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "[Unit]\nDescription=%s worker for %s\nAfter=network-online.target docker.service\nWants=network-online.target\n\n", app.AppName, project)
	fmt.Fprintf(&b, "[Service]\nType=simple\nExecStart=%q work %q\n", exe, project)
	fmt.Fprintf(&b, "# Optional file you create yourself (chmod 600) with the credentials the agent needs.\nEnvironmentFile=-%%h/.config/%s/worker.env\n", app.BinaryName)
	for _, kv := range passthroughEnv() {
		fmt.Fprintf(&b, "Environment=%q\n", kv)
	}
	b.WriteString("Restart=on-failure\nRestartSec=60\nKillSignal=SIGTERM\nTimeoutStopSec=120\n\n[Install]\nWantedBy=default.target\n")
	return b.String()
}

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;").Replace(s)
}

func launchdPlist(label, exe, project, logDir string) string {
	var b strings.Builder
	b.WriteString(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
`)
	fmt.Fprintf(&b, "  <key>Label</key><string>%s</string>\n", xmlEscape(label))
	fmt.Fprintf(&b, "  <key>ProgramArguments</key>\n  <array>\n    <string>%s</string>\n    <string>work</string>\n    <string>%s</string>\n  </array>\n", xmlEscape(exe), xmlEscape(project))
	b.WriteString("  <key>EnvironmentVariables</key>\n  <dict>\n")
	fmt.Fprintf(&b, "    <key>PATH</key><string>%s</string>\n", xmlEscape("/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"))
	for _, kv := range passthroughEnv() {
		k, v, _ := strings.Cut(kv, "=")
		fmt.Fprintf(&b, "    <key>%s</key><string>%s</string>\n", xmlEscape(k), xmlEscape(v))
	}
	b.WriteString("  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key>\n  <dict><key>SuccessfulExit</key><false/></dict>\n  <key>ThrottleInterval</key><integer>60</integer>\n")
	fmt.Fprintf(&b, "  <key>StandardOutPath</key><string>%s</string>\n  <key>StandardErrorPath</key><string>%s</string>\n</dict>\n</plist>\n",
		xmlEscape(filepath.Join(logDir, "worker.log")), xmlEscape(filepath.Join(logDir, "worker.log")))
	return b.String()
}

// agentEnvHint names the credential variables of the configured runner.
func agentEnvHint(runnerName string) string {
	if runnerName == "codex" {
		return "CODEX_API_KEY=… or OPENAI_API_KEY=…"
	}
	return "CLAUDE_CODE_OAUTH_TOKEN=… or ANTHROPIC_API_KEY=…"
}

// tokenCommandKey is the config key holding the runner's credential command.
func tokenCommandKey(runnerName string) string {
	if runnerName == "codex" {
		return "runner.token_command"
	}
	return "claude_token_command"
}
