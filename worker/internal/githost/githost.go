// Package githost publishes an accepted change set: it builds the commit on
// the host from data (never from files extracted out of the sandbox), pushes
// the task branch and opens the pull request. Git credentials live only on
// the host and never enter the sandbox.
package githost

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/url"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/app"
	"github.com/ghvstcode/agentfund/worker/internal/gitx"
)

// Request is everything needed to publish one run.
type Request struct {
	RepoDir    string // bare cache holding BaseCommit
	RepoURL    string
	BaseBranch string
	BaseCommit string
	Branch     string // agentfund/<task-id>-<claim-short>
	Changes    []gitx.TreeChange
	Title      string // PR title
	Body       string // PR body
	Message    string // full commit message including trailers
}

// Published is the outcome reported to the server.
type Published struct {
	Branch  string
	PRURL   string
	HeadSHA string
}

// Host is a place branches are pushed to and pull requests opened on.
type Host interface {
	Name() string
	Publish(ctx context.Context, req Request) (Published, error)
}

// Commit identity used for worker commits.
const (
	AuthorName  = app.AppName + " worker"
	AuthorEmail = "worker@" + app.BinaryName + ".invalid"
)

// BranchName returns the protocol-mandated branch for a claim (protocol.md §5):
// agentfund/<manifest id>-<first 8 characters after clm_>.
func BranchName(manifestID, claimID string) (string, error) {
	short, ok := strings.CutPrefix(claimID, "clm_")
	if !ok || len(short) < 8 {
		return "", fmt.Errorf("claim id %q has no clm_ prefix or is too short", claimID)
	}
	if !regexp.MustCompile(`^[0-9]{4}-[a-z0-9]+(-[a-z0-9]+)*$`).MatchString(manifestID) || !regexp.MustCompile(`^[a-z0-9]{8}$`).MatchString(short[:8]) {
		return "", fmt.Errorf("cannot build a branch name from task %q and claim %q", manifestID, claimID)
	}
	return app.BranchPrefix + manifestID + "-" + short[:8], nil
}

// CommitMessage builds the commit message with the AgentFund trailers.
func CommitMessage(title, task, claim, manifestSHA256 string) string {
	return fmt.Sprintf("%s\n\nAutomated change produced by an %s worker run.\n\n%s-Task: %s\n%s-Claim: %s\n%s-Manifest-SHA256: %s\n",
		oneLine(title), app.AppName, app.TrailerPrefix, task, app.TrailerPrefix, claim, app.TrailerPrefix, manifestSHA256)
}

func oneLine(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if len(s) > 120 {
		s = s[:120]
	}
	return s
}

// For picks the host implementation for a repo URL.
func For(repoURL string) (Host, error) {
	u, err := url.Parse(repoURL)
	if err != nil {
		return nil, fmt.Errorf("unparsable repo URL %q", repoURL)
	}
	switch {
	case u.Scheme == "file":
		return Local{}, nil
	case u.Scheme == "https" && strings.EqualFold(u.Hostname(), "github.com"):
		return &GitHub{}, nil
	}
	return nil, fmt.Errorf("no publisher for git host %q (supported: github.com, file://)", u.Host)
}

func buildCommit(ctx context.Context, req Request) (string, error) {
	if len(req.Changes) == 0 {
		return "", gitx.ErrNoChanges
	}
	return gitx.BuildCommit(ctx, req.RepoDir, gitx.CommitSpec{
		Parent: req.BaseCommit, Changes: req.Changes, Message: req.Message, AuthorName: AuthorName, AuthorEmail: AuthorEmail,
	})
}

var branchRE = regexp.MustCompile(`^agentfund/[0-9]{4}-[a-z0-9-]+$`)

func checkBranch(b string) error {
	if !branchRE.MatchString(b) {
		return fmt.Errorf("refusing to push to branch %q", b)
	}
	return nil
}

// Local publishes to a file:// repository by pushing the branch straight to
// it. It exists for tests and local end-to-end runs; the "PR URL" is
// file://…#<branch>.
type Local struct{}

// Name implements Host.
func (Local) Name() string { return "local" }

// Publish implements Host.
func (Local) Publish(ctx context.Context, req Request) (Published, error) {
	if err := gitx.CheckRepoURL(req.RepoURL); err != nil {
		return Published{}, err
	}
	if !strings.HasPrefix(req.RepoURL, "file://") {
		return Published{}, errors.New("local publisher only handles file:// URLs")
	}
	if err := checkBranch(req.Branch); err != nil {
		return Published{}, err
	}
	sha, err := buildCommit(ctx, req)
	if err != nil {
		return Published{}, err
	}
	if _, err := gitx.Run(ctx, req.RepoDir, "push", "-q", "--", req.RepoURL, sha+":refs/heads/"+req.Branch); err != nil {
		return Published{}, fmt.Errorf("push %s: %w", req.Branch, err)
	}
	return Published{Branch: req.Branch, PRURL: req.RepoURL + "#" + req.Branch, HeadSHA: sha}, nil
}

// CommandRunner runs a host command (the gh CLI) and returns its stdout.
type CommandRunner func(ctx context.Context, name string, args ...string) (string, error)

func execRunner(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return strings.TrimSpace(out.String()), fmt.Errorf("%s %s: %w: %s", name, strings.Join(args[:min(len(args), 3)], " "), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// GitHub publishes through the donor's `gh` CLI session: fork (if the donor
// cannot push to the project), push the branch, open the pull request.
type GitHub struct {
	// Run executes gh; nil uses the real binary.
	Run CommandRunner
	// Push pushes sha to the branch of the given repository URL; nil uses git
	// with gh as the credential helper.
	Push func(ctx context.Context, repoDir, pushURL, sha, branch string) error
	// RetryDelay is the pause between push attempts to a freshly created fork.
	RetryDelay time.Duration
}

// Name implements Host.
func (g *GitHub) Name() string { return "github" }

var ownerRepoRE = regexp.MustCompile(`^/([A-Za-z0-9][A-Za-z0-9-]{0,38})/([A-Za-z0-9._-]{1,100})$`)

// ParseGitHubRepo extracts owner and repo from an https://github.com URL.
func ParseGitHubRepo(repoURL string) (owner, repo string, err error) {
	u, perr := url.Parse(repoURL)
	if perr != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), "github.com") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", "", fmt.Errorf("%q is not an https://github.com repository URL", repoURL)
	}
	m := ownerRepoRE.FindStringSubmatch(strings.TrimSuffix(strings.TrimSuffix(u.Path, "/"), ".git"))
	if m == nil || m[2] == "." || m[2] == ".." {
		return "", "", fmt.Errorf("%q is not an https://github.com/<owner>/<repo> URL", repoURL)
	}
	return m[1], m[2], nil
}

// repoAccess asks GitHub, as the donor, whether upstream is private and whether the donor can push to it.
func repoAccess(ctx context.Context, run CommandRunner, upstream string) (private, push bool, err error) {
	out, err := run(ctx, "gh", "api", "repos/"+upstream, "--jq", `"\(.private) \(.permissions.push)"`)
	if err != nil {
		return false, false, fmt.Errorf("read %s with your gh login: %w", upstream, err)
	}
	answer := strings.TrimSpace(out)
	switch answer {
	case "true true":
		return true, true, nil
	case "true false", "true null":
		return true, false, nil
	case "false true", "false false", "false null":
		return false, answer == "false true", nil
	}
	return false, false, fmt.Errorf("unexpected answer from gh about %s: %q", upstream, out)
}

// Preflight checks, before any work is done, that the donor's gh login can publish to the
// repository: logged in, and with write access when the repository is private.
func (g *GitHub) Preflight(ctx context.Context, repoURL string) error {
	run := g.Run
	if run == nil {
		run = execRunner
	}
	owner, repo, err := ParseGitHubRepo(repoURL)
	if err != nil {
		return err
	}
	login, err := run(ctx, "gh", "api", "user", "--jq", ".login")
	if err != nil || login == "" {
		return fmt.Errorf("gh is not logged in to github.com (run `gh auth login`): %w", err)
	}
	private, canPush, err := repoAccess(ctx, run, owner+"/"+repo)
	if err != nil {
		return err
	}
	if private && !canPush {
		return fmt.Errorf("%s/%s is private and %s cannot push to it: backing a private project needs write access to its repository", owner, repo, login)
	}
	return nil
}

func gitPush(ctx context.Context, repoDir, pushURL, sha, branch string) error {
	_, err := gitx.Cmd{
		Dir:    repoDir,
		Args:   []string{"push", "-q", "--", pushURL, sha + ":refs/heads/" + branch},
		Config: []string{"credential.helper=!gh auth git-credential"},
	}.Run(ctx)
	return err
}

// Publish implements Host.
func (g *GitHub) Publish(ctx context.Context, req Request) (Published, error) {
	run, push := g.Run, g.Push
	if run == nil {
		run = execRunner
	}
	if push == nil {
		push = gitPush
	}
	delay := g.RetryDelay
	if delay == 0 {
		delay = 5 * time.Second
	}
	owner, repo, err := ParseGitHubRepo(req.RepoURL)
	if err != nil {
		return Published{}, err
	}
	if err := checkBranch(req.Branch); err != nil {
		return Published{}, err
	}
	upstream := owner + "/" + repo

	login, err := run(ctx, "gh", "api", "user", "--jq", ".login")
	if err != nil || login == "" {
		return Published{}, fmt.Errorf("gh is not logged in to github.com (run `gh auth login`): %w", err)
	}
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9-]{0,38}$`).MatchString(login) {
		return Published{}, fmt.Errorf("unexpected GitHub login %q", login)
	}

	target, head := upstream, req.Branch
	private, canPush, err := repoAccess(ctx, run, upstream)
	if err != nil {
		return Published{}, err
	}
	if private && !canPush {
		return Published{}, fmt.Errorf("%s is private and %s cannot push to it: backing a private project needs write access to its repository", upstream, login)
	}
	// A private repository cannot be forked in general, so its branch goes to the repository
	// itself. A public one keeps the fork path even when the donor could push, so the
	// branch's CI never runs with the project's secrets.
	if !strings.EqualFold(login, owner) && !private {
		// Ensure a fork exists; idempotent when it already does.
		if _, err := run(ctx, "gh", "repo", "fork", upstream, "--clone=false"); err != nil {
			return Published{}, fmt.Errorf("fork %s: %w", upstream, err)
		}
		fork, err := run(ctx, "gh", "api", "graphql",
			"-f", "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){forks(first:1,affiliations:[OWNER]){nodes{nameWithOwner}}}}",
			"-f", "owner="+owner, "-f", "name="+repo,
			"--jq", ".data.repository.forks.nodes[0].nameWithOwner")
		if err != nil || !regexp.MustCompile(`^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$`).MatchString(fork) {
			// Fall back to the conventional name.
			fork = login + "/" + repo
		}
		if !strings.EqualFold(strings.SplitN(fork, "/", 2)[0], login) {
			return Published{}, fmt.Errorf("fork lookup returned %q, which does not belong to %s", fork, login)
		}
		target, head = fork, login+":"+req.Branch
	}

	sha, err := buildCommit(ctx, req)
	if err != nil {
		return Published{}, err
	}
	pushURL := "https://github.com/" + target + ".git"
	var pushErr error
	for attempt := 0; attempt < 6; attempt++ {
		if pushErr = push(ctx, req.RepoDir, pushURL, sha, req.Branch); pushErr == nil {
			break
		}
		select { // a fresh fork can take a moment to become pushable
		case <-ctx.Done():
			return Published{}, ctx.Err()
		case <-time.After(delay):
		}
	}
	if pushErr != nil {
		return Published{}, fmt.Errorf("push %s to %s: %w", req.Branch, target, pushErr)
	}

	prURL, err := run(ctx, "gh", "pr", "create", "--repo", upstream, "--base", req.BaseBranch, "--head", head,
		"--title", oneLine(req.Title), "--body", req.Body)
	if err != nil {
		// A PR for this head may already exist (retry after a crash).
		existing, verr := run(ctx, "gh", "pr", "view", head, "--repo", upstream, "--json", "url", "--jq", ".url")
		if verr != nil || existing == "" {
			return Published{}, fmt.Errorf("open pull request: %w", err)
		}
		prURL = existing
	}
	if i := strings.LastIndex(prURL, "https://"); i > 0 {
		prURL = prURL[i:]
	}
	prURL = strings.TrimSpace(prURL)
	if !strings.HasPrefix(prURL, "https://github.com/") || strings.ContainsAny(prURL, " \n") {
		return Published{}, fmt.Errorf("gh returned an unexpected pull request URL %q", prURL)
	}
	return Published{Branch: req.Branch, PRURL: prURL, HeadSHA: sha}, nil
}
