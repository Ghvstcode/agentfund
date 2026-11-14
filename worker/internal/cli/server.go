package cli

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/app"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/policy"
	"github.com/agentfund/agentfund/worker/internal/spec"
	"github.com/agentfund/agentfund/worker/internal/store"
	"github.com/agentfund/agentfund/worker/internal/tokfmt"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

func signalContext() (context.Context, context.CancelFunc) {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	return ctx, cancel
}

func loginCmd(e *env) *cobra.Command {
	var keyStdin bool
	var via string
	cmd := &cobra.Command{
		Use:   "login <server-url>",
		Short: "Store a server API key (af_…) after checking it",
		Long: `Read an ` + app.AppName + ` API key (created in the server's UI, prefix af_), check it
with GET /v1/me and store it in credentials.yaml (mode 0600), keyed by server
URL. With --key-stdin the key is read from standard input without a prompt.

With --via <home-server-url> no account on the server is needed: the server
you are already logged in to (your home) signs a short-lived statement of who
you are, the target server exchanges it for an API key of its own, and that
key is stored like any other. It works when both servers have federation on
and the target's admin has peered with your home server and accepts its
identities. There you appear as <handle>@<home host>. Your home API key is
sent only to your home server.

This is the key for the ` + app.AppName + ` server only. Credentials for the coding
agent are never stored by this tool.`,
		Example: "  " + app.BinaryName + " login https://fund.example\n" +
			"  " + app.BinaryName + " login https://other.example --via https://fund.example",
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			server, err := config.NormalizeServer(args[0])
			if err != nil {
				return exitWith(ExitUsage, "%v", err)
			}
			if cmd.Flags().Changed("via") {
				if keyStdin {
					return exitWith(ExitUsage, "--via and --key-stdin cannot be combined: a federated login reads no key")
				}
				return loginVia(cmd.Context(), e, server, via)
			}
			var key string
			if keyStdin {
				line, rerr := e.stdin().ReadString('\n')
				if rerr != nil && line == "" {
					return errors.New("no key on stdin")
				}
				key = strings.TrimSpace(line)
			} else if key, err = e.readSecret("API key for " + server + " (af_…): "); err != nil {
				return fmt.Errorf("read key: %w", err)
			}
			if !strings.HasPrefix(key, "af_") || strings.ContainsAny(key, " \t\r\n") {
				return errors.New("that does not look like an API key (expected the af_ prefix)")
			}
			ctx, cancel := context.WithTimeout(cmd.Context(), 30*time.Second)
			defer cancel()
			c := api.New(server, key)
			if _, err := c.Negotiate(ctx, spec.SpecVersion); err != nil {
				return err
			}
			me, err := c.Me(ctx)
			if err != nil {
				return fmt.Errorf("the server did not accept the key: %w", err)
			}
			creds, err := config.LoadCredentials()
			if err != nil {
				return err
			}
			creds.Servers[server] = config.ServerCredential{APIKey: key}
			if err := creds.Save(); err != nil {
				return err
			}
			fmt.Fprintf(e.out, "logged in to %s as %s (%s); key stored in %s\n", server, me.Handle, me.Role, config.CredentialsPath())
			return nil
		},
	}
	cmd.Flags().BoolVar(&keyStdin, "key-stdin", false, "read the API key from standard input")
	cmd.Flags().StringVar(&via, "via", "", "log in with your account on this home server (federated login) instead of an API key")
	return cmd
}

// loginVia is the federated login: the home server signs an identity
// assertion for the target, the target exchanges it for an API key of its own.
func loginVia(ctx context.Context, e *env, server, via string) error {
	home, err := config.NormalizeServer(via)
	if err != nil {
		return exitWith(ExitUsage, "--via: %v", err)
	}
	if home == server {
		return exitWith(ExitUsage, "--via must name a different server than the one you log in to (%s)", server)
	}
	creds, err := config.LoadCredentials()
	if err != nil {
		return err
	}
	homeKey := creds.Servers[home].APIKey
	if homeKey == "" {
		return fmt.Errorf("no stored API key for %s: run `%s login %s` first, then repeat this command", home, app.BinaryName, home)
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	homeClient, target := api.New(home, homeKey), api.New(server, "")
	for _, c := range []*api.Client{homeClient, target} {
		meta, err := c.Negotiate(ctx, spec.SpecVersion)
		if err != nil {
			return err
		}
		if !meta.Federation() {
			return federationOff(c.BaseURL, server)
		}
	}
	as, err := homeClient.CreateIdentityAssertion(ctx, server)
	switch {
	case api.IsCode(err, api.CodeUnauthorized):
		return fmt.Errorf("%s did not accept the stored key: run `%s login %s` again: %w", home, app.BinaryName, home, err)
	case api.IsCode(err, api.CodeForbidden):
		return fmt.Errorf("your account on %s is itself a federated one and cannot vouch for you elsewhere; pass the server your account was created on to --via: %w", home, err)
	case api.IsCode(err, api.CodeNotFound):
		return federationOff(home, server)
	case err != nil:
		return fmt.Errorf("%s did not issue an identity assertion: %w", home, err)
	}
	host, _ := os.Hostname()
	label := strings.TrimSpace(app.BinaryName + " worker " + host)
	if len(label) > 80 {
		label = label[:80]
	}
	auth, err := target.AuthFederated(ctx, as.Assertion, label)
	switch {
	case api.IsCode(err, api.CodePeerNotTrusted):
		return fmt.Errorf("%s does not accept identities from %s. Ask its admin to peer with %s and turn on 'accept identities', or create an account there and use `%s login %s`",
			server, home, home, app.BinaryName, server)
	case api.IsCode(err, api.CodeAssertionInvalid):
		return fmt.Errorf("%s rejected the identity assertion from %s (expired, already used, or the signature does not match the key it pinned for %s). "+
			"Try again; if it keeps failing, check this machine's clock and ask the admin of %s to re-sync the peer %s: %w", server, home, home, server, home, err)
	case api.IsCode(err, api.CodeNotFound):
		return federationOff(server, server)
	case err != nil:
		return fmt.Errorf("%s did not accept the identity assertion: %w", server, err)
	}
	if !strings.HasPrefix(auth.Key, "af_") || strings.ContainsAny(auth.Key, " \t\r\n") {
		return fmt.Errorf("%s answered without a usable API key", server)
	}
	creds.Servers[server] = config.ServerCredential{APIKey: auth.Key}
	if err := creds.Save(); err != nil {
		return err
	}
	fmt.Fprintf(e.out, "logged in to %s as %s (%s) via %s; key stored in %s\n", server, auth.User.Handle, auth.User.Role, home, config.CredentialsPath())
	return nil
}

// federationOff explains that instance (the home or the target server) does not federate.
func federationOff(instance, server string) error {
	return fmt.Errorf("%s has federation turned off, so --via cannot be used. Create an account on %s and use `%s login %s`", instance, server, app.BinaryName, server)
}

// readAt reads a regular file at a commit by tree lookup.
func readAt(ctx context.Context, repo, commit, path string) ([]byte, error) {
	entries, err := gitx.LsTree(ctx, repo, commit, "", false)
	if err != nil {
		return nil, err
	}
	for _, en := range entries {
		if en.Path == path {
			if !en.IsRegular() {
				return nil, fmt.Errorf("%s is not a regular file", path)
			}
			return gitx.ReadBlob(ctx, repo, en.OID)
		}
	}
	return nil, fmt.Errorf("%s does not exist at %s", path, commit)
}

func renderManifest(w io.Writer, m *spec.Manifest, sha string) {
	fmt.Fprintf(w, "──────────────────────────────────────────────────────────────────────────────\n")
	fmt.Fprintf(w, "TASK %s — %s\n", m.ID, m.Title)
	fmt.Fprintf(w, "  manifest sha256: %s\n", sha)
	fmt.Fprintf(w, "  max_tokens:      %s\n", tokfmt.Format(m.MaxTokens))
	fmt.Fprintf(w, "  timeout_minutes: %d\n", m.TimeoutMinutes)
	fmt.Fprintf(w, "  base_branch:     %s\n", m.BaseBranch)
	if len(m.DependsOn) > 0 {
		fmt.Fprintf(w, "  depends_on:      %s\n", strings.Join(m.DependsOn, ", "))
	}
	fmt.Fprintf(w, "  scope.write (the agent may change ONLY these):\n")
	for _, g := range m.Scope.Write {
		fmt.Fprintf(w, "    - %s\n", g)
	}
	if m.ReadSet {
		fmt.Fprintf(w, "  scope.read (everything else is removed from the sandbox):\n")
		for _, g := range m.Scope.Read {
			fmt.Fprintf(w, "    - %s\n", g)
		}
	} else {
		fmt.Fprintf(w, "  scope.read: (unset — the whole repository is readable in the sandbox)\n")
	}
	fmt.Fprintf(w, "  verify (runs in the sandbox after the agent; exit 0 = pass):\n    %s\n", strings.ReplaceAll(m.Verify, "\n", "\n    "))
	fmt.Fprintf(w, "  prompt (given to the agent verbatim):\n")
	for _, line := range strings.Split(strings.TrimRight(m.Prompt, "\n"), "\n") {
		fmt.Fprintf(w, "    │ %s\n", line)
	}
	fmt.Fprintln(w)
}

// page shows text through $PAGER when interactive, otherwise prints it.
func (e *env) page(text string, usePager bool) {
	if usePager && e.isTerminal() {
		pager := os.Getenv("PAGER")
		if pager == "" {
			pager = "less -R"
		}
		cmd := exec.Command("sh", "-c", pager)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = strings.NewReader(text), e.out, e.err
		if cmd.Run() == nil {
			return
		}
	}
	fmt.Fprint(e.out, text)
}

func approveCmd(e *env) *cobra.Command {
	var yes, noPager, followFlag, noFollowFlag bool
	var pubkeyFlag, commitFlag string
	cmd := &cobra.Command{
		Use:   "approve <server-url>/<project>",
		Short: "Review a project's signed tasks and pin its key and commit",
		Long: `Fetch the project from the server, clone its repository, verify the task
lock at the pinned commit against the maintainer key, show the key
fingerprint and every manifest in full (prompt, scope, verify, caps), and —
after you confirm — pin {pubkey, commit, lock hash} in config.yaml.

Compare the fingerprint with the one on the server's Audit tab: the repository
(agentfund.yaml) and the server are two separate channels for the same key.
If they disagree, approve refuses unless you pass the key you trust with
--pubkey. Running approve again re-approves a newer commit.

Every merged pull request moves the project to a newer commit. approve asks
whether to keep working when that commit's signed task list is byte-identical
to the one you reviewed (stored per project as follow_unchanged_lock): the
prompts cannot change, but the repository's code may have, and it runs only
inside the sandbox. Non-interactively: --follow-unchanged-lock or
--no-follow-unchanged-lock;
--yes alone leaves the setting as it is (off by default).`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			ref, err := config.ParseRef(args[0])
			if err != nil {
				return exitWith(ExitUsage, "%v", err)
			}
			cfg, err := config.Load()
			if err != nil {
				return err
			}
			ctx, cancel := signalContext()
			defer cancel()
			client := api.New(ref.Server, "")
			meta, err := client.Negotiate(ctx, spec.SpecVersion)
			if err != nil {
				return err
			}
			proj, err := client.Project(ctx, ref.Slug)
			if err != nil {
				return fmt.Errorf("fetch project: %w", err)
			}
			commit := proj.PinnedCommit
			if commitFlag != "" {
				commit = commitFlag
			}
			if !gitx.IsFullSHA1(commit) {
				return fmt.Errorf("the project has no usable pinned commit (%q); the server may not have indexed it yet", commit)
			}
			if h, ok := policy.HostAllowed(cfg.Global.AllowedGitHosts, proj.RepoURL); !ok {
				return fmt.Errorf("git host %q of %s is not in allowed_git_hosts (%s); add it to %s if you trust it",
					h, proj.RepoURL, strings.Join(cfg.Global.AllowedGitHosts, ", "), config.Path())
			}
			fmt.Fprintf(e.out, "Instance:  %s (%s %s)\nProject:   %s — %s\nRepo:      %s\nStatus:    %s, trust tier %q\nCommit:    %s\n",
				meta.Name, meta.App, meta.Version, proj.Name, proj.Description, proj.RepoURL, proj.Status, proj.Trust.Tier, commit)

			repoDir := gitx.CachePath(config.ReposDir(), proj.RepoURL)
			fmt.Fprintf(e.out, "Fetching the repository…\n")
			if err := gitx.Fetch(ctx, repoDir, proj.RepoURL, commit); err != nil {
				return err
			}

			// Two channels: the key the server registered, and the key the repo publishes.
			serverKey := proj.Pubkey
			repoKey := ""
			if raw, err := readAt(ctx, repoDir, commit, app.DescriptorFile); err == nil {
				if d, derr := spec.ParseDescriptor(raw); derr == nil {
					repoKey = d.Pubkey
				} else {
					fmt.Fprintf(e.out, "warning: %s at %s is invalid: %v\n", app.DescriptorFile, commit[:12], derr)
				}
			}
			pin := serverKey
			if pubkeyFlag != "" {
				pin = pubkeyFlag
			}
			pinKey, err := minisign.ParsePublicKey(pin)
			if err != nil {
				return fmt.Errorf("public key to pin is unusable: %w", err)
			}
			lr, verr := verify.Lock(ctx, repoDir, commit, pin)

			fp := func(k string) string {
				f, err := minisign.Fingerprint(k)
				if err != nil {
					return "(not a valid key)"
				}
				return f
			}
			labels := []string{"server publishes:", "repo " + app.DescriptorFile + ":", "--pubkey (you):"}
			width := 0
			for _, l := range labels {
				width = max(width, len(l))
			}
			keyLine := func(label, key, fingerprint string) {
				fmt.Fprintf(e.out, "  %-*s %s\n  %-*s %s\n", width, label, key, width, "", fingerprint)
			}
			fmt.Fprintf(e.out, "\nMaintainer key\n")
			keyLine(labels[0], serverKey, fp(serverKey))
			if repoKey != "" {
				keyLine(labels[1], repoKey, fp(repoKey))
			} else {
				fmt.Fprintf(e.out, "  %-*s (missing or unreadable)\n", width, labels[1])
			}
			if pubkeyFlag != "" {
				keyLine(labels[2], pin, pinKey.Fingerprint())
			}
			if verr != nil {
				return fmt.Errorf("the task lock at %s does not verify against %s: %w", commit[:12], pinKey.Fingerprint(), verr)
			}
			switch {
			case pubkeyFlag != "":
				fmt.Fprintf(e.out, "  → pinning the key you passed with --pubkey.\n")
			case repoKey == serverKey:
				fmt.Fprintf(e.out, "  → repo key == server key: MATCH.\n")
			case repoKey != "" && repoKey == lr.Signer.String() && lr.Rotations > 0:
				fmt.Fprintf(e.out, "  → repo key differs from the server's registered key, but a valid rotation chain of %d link(s) signed by the registered key leads to it.\n", lr.Rotations)
			default:
				return fmt.Errorf("the key in the repository's %s and the key the server publishes DIFFER and no rotation chain connects them. "+
					"One of the two channels is wrong or compromised. Ask the maintainer out of band which fingerprint is right, then re-run with --pubkey <key>", app.DescriptorFile)
			}
			fmt.Fprintf(e.out, "\nFINGERPRINT TO PIN:  %s\n  Compare it with the fingerprint on the project's Audit tab: %s/%s\n  (server says: %s)\n",
				pinKey.Fingerprint(), ref.Server, ref.Slug, proj.PubkeyFingerprint)
			if proj.PubkeyFingerprint != "" && pubkeyFlag == "" && proj.PubkeyFingerprint != pinKey.Fingerprint() {
				return fmt.Errorf("the server's pubkey_fingerprint (%s) is not the fingerprint of the key it publishes (%s); refusing", proj.PubkeyFingerprint, pinKey.Fingerprint())
			}
			fmt.Fprintf(e.out, "Lock:      signature OK (signed by %s, %d rotation link(s)), %d manifest(s), sha256 %s\n\n",
				lr.Signer.Fingerprint(), lr.Rotations, len(lr.Lock.Manifests), lr.LockSHA256)

			var b strings.Builder
			var total int64
			deps := map[string][]string{}
			sizes := map[string]int64{}
			for _, en := range lr.Lock.Manifests {
				_, m, err := lr.ReadManifest(ctx, en.ID)
				if err != nil {
					return fmt.Errorf("manifest %s is invalid: %w", en.Path, err)
				}
				deps[m.ID] = m.DependsOn
				sizes[m.ID] = m.MaxTokens
				total += m.MaxTokens
				renderManifest(&b, m, en.SHA256)
			}
			fmt.Fprintf(&b, "%d task(s), up to %s tokens in total if every task runs to its cap.\n", len(lr.Lock.Manifests), tokfmt.Format(total))
			b.WriteString(capsSummary(cfg, cfg.Projects[ref.Key()], proj, sizes))
			e.page(b.String(), !yes && !noPager)

			if existing, ok := cfg.Projects[ref.Key()]; ok {
				switch {
				case existing.Pubkey != pin:
					fmt.Fprintf(e.out, "\nNOTE: you previously pinned a DIFFERENT key for this project (%s). Approving replaces it.\n", fp(existing.Pubkey))
				case existing.ApprovedCommit == commit:
					fmt.Fprintf(e.out, "\nYou already approved this exact commit.\n")
				default:
					fmt.Fprintf(e.out, "\nRe-approval: previously approved commit %s.\n", existing.ApprovedCommit)
				}
			}
			fmt.Fprintf(e.out, "\nApproving means: tasks from commit %s (and its ancestors), signed by the key above, may run on this machine\n"+
				"in the sandbox, under your coding-agent credentials, within the caps in %s.\n", commit[:12], config.Path())
			if !yes {
				ok, err := e.confirm("Pin this key and commit?")
				if err != nil {
					return err
				}
				if !ok {
					return exitWith(ExitError, "not approved; nothing was changed")
				}
			}
			p := cfg.Projects[ref.Key()]
			if p == nil {
				p = &config.Project{}
				cfg.Projects[ref.Key()] = p
			}
			// Following: with both follow policies off, every merged PR needs a new approval.
			switch {
			case followFlag:
				v := true
				p.FollowUnchangedLock = &v
			case noFollowFlag:
				v := false
				p.FollowUnchangedLock = &v
			case !yes:
				fmt.Fprintf(e.out, "\nProjects move: every merged pull request creates a newer commit than the one you just approved.\n"+
					"Keep working when the project moves to a newer commit whose signed task list is byte-identical to what you just reviewed? [y/N]: ")
				line, _ := e.stdin().ReadString('\n')
				a := strings.ToLower(strings.TrimSpace(line))
				v := a == "y" || a == "yes"
				p.FollowUnchangedLock = &v
			}
			follows := cfg.Global.FollowUnchangedLock
			if p.FollowUnchangedLock != nil {
				follows = *p.FollowUnchangedLock
			}
			if follows {
				fmt.Fprintf(e.out, "follow_unchanged_lock: ON for this project — the prompts, scopes and verify commands you reviewed cannot change without a new approval; "+
					"the repository's code may have changed, and it runs only inside the sandbox.\n")
			} else {
				fmt.Fprintf(e.out, "follow_unchanged_lock: off for this project — after the project moves to a newer commit you will need to run `%s approve %s` again "+
					"(or re-run with --follow-unchanged-lock).\n", app.BinaryName, ref.Key())
			}
			p.Server, p.Slug, p.Pubkey = ref.Server, ref.Slug, pin
			p.ApprovedCommit, p.ApprovedLockSHA256, p.ApprovedAt = commit, lr.LockSHA256, time.Now().UTC().Truncate(time.Second)
			if err := cfg.Save(); err != nil {
				return err
			}
			// The donor just re-reviewed the project: tasks that failed here earlier may be tried again.
			if n, err := store.Open(config.StorePath()).ClearRetries(ref.Key()); err == nil && n > 0 {
				fmt.Fprintf(e.out, "cleared the retry cooldown (retry_failed_after) of %d earlier failed run(s)\n", n)
			}
			fmt.Fprintf(e.out, "approved %s at %s; written to %s\nNext: %s dry-run %s   then   %s work %s\n",
				ref.Key(), commit[:12], config.Path(), app.BinaryName, ref.Slug, app.BinaryName, ref.Slug)
			return nil
		},
	}
	cmd.Flags().BoolVar(&yes, "yes", false, "approve without asking (non-interactive); manifests are printed, not paged")
	cmd.Flags().BoolVar(&noPager, "no-pager", false, "print manifests instead of opening $PAGER")
	cmd.Flags().StringVar(&pubkeyFlag, "pubkey", "", "pin this maintainer key (minisign encoding) instead of the one the server publishes")
	cmd.Flags().BoolVar(&followFlag, "follow-unchanged-lock", false, "keep working on newer commits whose signed task list (MANIFEST.lock) is byte-identical to the one approved now")
	cmd.Flags().BoolVar(&noFollowFlag, "no-follow-unchanged-lock", false, "require a new approval whenever the project moves to a newer commit (the default)")
	cmd.Flags().BoolVar(&noFollowFlag, "no-follow", false, "alias of --no-follow-unchanged-lock")
	_ = cmd.Flags().MarkHidden("no-follow")
	cmd.MarkFlagsMutuallyExclusive("follow-unchanged-lock", "no-follow-unchanged-lock")
	cmd.MarkFlagsMutuallyExclusive("follow-unchanged-lock", "no-follow")
	cmd.Flags().StringVar(&commitFlag, "commit", "", "approve this commit instead of the server's pinned commit")
	return cmd
}
