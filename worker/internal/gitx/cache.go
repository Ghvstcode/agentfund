package gitx

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var unsafeName = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// CheckRepoURL accepts only https:// and file:// URLs without credentials.
// Everything else (ssh, ext::, option-looking strings) is refused before git
// ever sees it.
func CheckRepoURL(repoURL string) error {
	if strings.HasPrefix(repoURL, "-") || strings.ContainsAny(repoURL, "\x00\n\r") {
		return fmt.Errorf("repo URL %q is malformed", repoURL)
	}
	u, err := url.Parse(repoURL)
	if err != nil {
		return fmt.Errorf("repo URL %q is malformed", repoURL)
	}
	switch u.Scheme {
	case "https":
		if u.Host == "" || u.User != nil {
			return fmt.Errorf("repo URL %q must be https://host/path without credentials", repoURL)
		}
	case "file":
		if u.Host != "" && u.Host != "localhost" {
			return fmt.Errorf("repo URL %q must not name a host", repoURL)
		}
	default:
		return fmt.Errorf("repo URL %q: scheme %q is not allowed", repoURL, u.Scheme)
	}
	return nil
}

// CachePath returns the bare cache directory for a repo URL under root.
func CachePath(root, repoURL string) string {
	sum := sha256.Sum256([]byte(repoURL))
	name := unsafeName.ReplaceAllString(strings.TrimSuffix(filepath.Base(repoURL), ".git"), "_")
	return filepath.Join(root, name+"-"+hex.EncodeToString(sum[:8])+".git")
}

// Auth says which credentials a fetch may use. The donor chooses it per
// project at approve time (projects[...].git_auth); the server never does.
type Auth string

const (
	// AuthNone fetches anonymously (public repositories).
	AuthNone Auth = ""
	// AuthGH lets git ask the donor's gh login for github.com credentials, for
	// private repositories. It is refused for any other host.
	AuthGH Auth = "gh"
)

// authConfig is the git configuration for a fetch with auth.
func authConfig(repoURL string, auth Auth) ([]string, error) {
	switch auth {
	case AuthNone:
		return nil, nil
	case AuthGH:
		u, err := url.Parse(repoURL)
		if err != nil || u.Scheme != "https" || !strings.EqualFold(u.Hostname(), "github.com") || u.Port() != "" {
			return nil, fmt.Errorf("git_auth gh only works for https://github.com repositories, not %q", repoURL)
		}
		// Credentials stay on github.com: the helper is scoped to it and redirects are off.
		return []string{"credential.https://github.com.helper=!gh auth git-credential", "http.followRedirects=false"}, nil
	}
	return nil, fmt.Errorf("unknown git_auth %q (use gh, or leave it empty)", auth)
}

// Fetch makes sure the bare cache at dir exists and holds the branches of
// repoURL plus the given commits. No hooks, tags or submodules are fetched.
func Fetch(ctx context.Context, dir, repoURL string, commits ...string) error {
	return FetchAuth(ctx, dir, repoURL, AuthNone, commits...)
}

// FetchAuth is Fetch with the donor-chosen credentials.
func FetchAuth(ctx context.Context, dir, repoURL string, auth Auth, commits ...string) error {
	if err := CheckRepoURL(repoURL); err != nil {
		return err
	}
	cfg, err := authConfig(repoURL, auth)
	if err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(dir, "HEAD")); err != nil {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return err
		}
		if _, err := Run(ctx, dir, "init", "-q", "--bare", "--initial-branch=main", "--template="); err != nil {
			return fmt.Errorf("init repo cache: %w", err)
		}
	}
	if _, err := (Cmd{Dir: dir, Config: cfg, Args: []string{"fetch", "-q", "--no-tags", "--prune", "--no-recurse-submodules", "--", repoURL, "+refs/heads/*:refs/remotes/origin/*"}}).Run(ctx); err != nil {
		return fmt.Errorf("fetch %s: %w", repoURL, err)
	}
	for _, c := range commits {
		if !IsFullOID(c) || CommitExists(ctx, dir, c) {
			continue
		}
		// The commit may be reachable only from a non-branch ref; ask for it by id.
		_, _ = Cmd{Dir: dir, Config: cfg, Args: []string{"fetch", "-q", "--no-tags", "--no-recurse-submodules", "--", repoURL, c}}.Run(ctx)
	}
	return nil
}

// ResolveBranch returns the commit a fetched branch points at.
func ResolveBranch(ctx context.Context, dir, branch string) (string, error) {
	if !regexp.MustCompile(`^[A-Za-z0-9._/-]+$`).MatchString(branch) || strings.HasPrefix(branch, "-") || strings.Contains(branch, "..") {
		return "", fmt.Errorf("bad branch name %q", branch)
	}
	out, err := Run(ctx, dir, "rev-parse", "--verify", "-q", "refs/remotes/origin/"+branch+"^{commit}")
	if err != nil {
		return "", fmt.Errorf("branch %s not found: %w", branch, err)
	}
	return strings.TrimSpace(string(out)), nil
}
