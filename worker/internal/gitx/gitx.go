// Package gitx runs the host git binary with a hardened, isolated
// configuration. Repository content is always treated as hostile: objects are
// read with plumbing commands by object id, never through a checked-out path.
package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var fullOID = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)

// IsFullOID reports whether s is a full lowercase hex object id.
func IsFullOID(s string) bool { return fullOID.MatchString(s) }

// IsFullSHA1 reports whether s is a full 40-hex commit id (what the protocol requires).
func IsFullSHA1(s string) bool { return len(s) == 40 && fullOID.MatchString(s) }

// baseConfig is prepended to every invocation. It disables everything that
// could make git execute code or follow configuration chosen by the repo.
var baseConfig = []string{
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.fsmonitor=false",
	"-c", "core.sshCommand=false",
	"-c", "core.askPass=",
	"-c", "credential.helper=",
	"-c", "protocol.ext.allow=never",
	"-c", "protocol.allow=never",
	"-c", "protocol.https.allow=always",
	"-c", "protocol.file.allow=always",
	"-c", "submodule.recurse=false",
	"-c", "fetch.recurseSubmodules=false",
	"-c", "commit.gpgsign=false",
	"-c", "tag.gpgsign=false",
	"-c", "gc.auto=0",
	"-c", "advice.detachedHead=false",
	"-c", "core.autocrlf=false",
	"-c", "core.symlinks=true",
	"-c", "safe.directory=*",
}

// Env returns the environment for git: no system/global config, no prompts.
func Env(extra ...string) []string {
	env := []string{
		"PATH=" + os.Getenv("PATH"),
		"HOME=" + os.Getenv("HOME"),
		"LANG=C", "LC_ALL=C",
		"GIT_CONFIG_NOSYSTEM=1",
		"GIT_CONFIG_GLOBAL=/dev/null",
		"GIT_TERMINAL_PROMPT=0",
		"GIT_ASKPASS=",
		"GIT_OPTIONAL_LOCKS=0",
	}
	if v := os.Getenv("TMPDIR"); v != "" {
		env = append(env, "TMPDIR="+v)
	}
	return append(env, extra...)
}

// Cmd is one git invocation.
type Cmd struct {
	Dir    string
	Args   []string
	Config []string // extra "key=value" pairs
	Env    []string // extra environment
	Stdin  io.Reader
	Stdout io.Writer
}

// ExitError carries git's exit code and stderr.
type ExitError struct {
	Args   []string
	Code   int
	Stderr string
}

func (e *ExitError) Error() string {
	return fmt.Sprintf("git %s: exit %d: %s", strings.Join(e.Args, " "), e.Code, strings.TrimSpace(e.Stderr))
}

// Run executes the command and returns stdout (unless Stdout is set).
func (c Cmd) Run(ctx context.Context) ([]byte, error) {
	args := append([]string{}, baseConfig...)
	for _, kv := range c.Config {
		args = append(args, "-c", kv)
	}
	args = append(args, c.Args...)
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = c.Dir
	cmd.Env = Env(c.Env...)
	cmd.Stdin = c.Stdin
	var out, errb bytes.Buffer
	if c.Stdout != nil {
		cmd.Stdout = c.Stdout
	} else {
		cmd.Stdout = &out
	}
	cmd.Stderr = &errb
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return out.Bytes(), &ExitError{Args: c.Args, Code: ee.ExitCode(), Stderr: errb.String()}
		}
		return nil, fmt.Errorf("git %s: %w", strings.Join(c.Args, " "), err)
	}
	return out.Bytes(), nil
}

// Run is shorthand for Cmd{Dir: dir, Args: args}.Run.
func Run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	return Cmd{Dir: dir, Args: args}.Run(ctx)
}

// TreeEntry is one line of `git ls-tree`.
type TreeEntry struct {
	Mode string // e.g. 100644, 100755, 120000, 160000, 040000
	Type string // blob, tree, commit
	OID  string
	Path string
}

// IsRegular reports whether the entry is a regular file blob.
func (e TreeEntry) IsRegular() bool {
	return e.Type == "blob" && (e.Mode == "100644" || e.Mode == "100755")
}

// LsTree lists the tree at commit. With recursive, blobs of the whole tree are
// returned (no tree entries); otherwise the direct children of dir ("" = root).
func LsTree(ctx context.Context, repo, commit, dir string, recursive bool) ([]TreeEntry, error) {
	if !IsFullOID(commit) {
		return nil, fmt.Errorf("ls-tree: %q is not a full object id", commit)
	}
	args := []string{"ls-tree", "-z", "--full-tree"}
	if recursive {
		args = append(args, "-r")
	}
	args = append(args, commit)
	if dir != "" {
		args = append(args, "--", strings.TrimSuffix(dir, "/")+"/")
	}
	out, err := Cmd{Dir: repo, Args: args, Config: []string{"core.quotePath=false"}}.Run(ctx)
	if err != nil {
		return nil, err
	}
	var entries []TreeEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		meta, path, ok := bytes.Cut(rec, []byte{'\t'})
		if !ok {
			return nil, fmt.Errorf("ls-tree: malformed record %q", rec)
		}
		f := strings.Fields(string(meta))
		if len(f) != 3 {
			return nil, fmt.Errorf("ls-tree: malformed record %q", rec)
		}
		entries = append(entries, TreeEntry{Mode: f[0], Type: f[1], OID: f[2], Path: string(path)})
	}
	return entries, nil
}

// MaxBlob bounds how much of a single blob ReadBlob will return.
const MaxBlob = 64 << 20

// ReadBlob returns the bytes of the blob with the given object id.
func ReadBlob(ctx context.Context, repo, oid string) ([]byte, error) {
	if !IsFullOID(oid) {
		return nil, fmt.Errorf("cat-file: %q is not a full object id", oid)
	}
	sz, err := Run(ctx, repo, "cat-file", "-s", oid)
	if err != nil {
		return nil, err
	}
	var n int64
	if _, err := fmt.Sscanf(strings.TrimSpace(string(sz)), "%d", &n); err != nil || n > MaxBlob {
		return nil, fmt.Errorf("cat-file: blob %s is too large or unreadable (%s bytes)", oid, strings.TrimSpace(string(sz)))
	}
	return Run(ctx, repo, "cat-file", "blob", oid)
}

// CommitExists reports whether commit names an existing commit object.
func CommitExists(ctx context.Context, repo, commit string) bool {
	if !IsFullOID(commit) {
		return false
	}
	_, err := Run(ctx, repo, "cat-file", "-e", commit+"^{commit}")
	return err == nil
}

// IsAncestor reports whether a is b or an ancestor of b. Missing objects yield false.
func IsAncestor(ctx context.Context, repo, a, b string) (bool, error) {
	if !IsFullOID(a) || !IsFullOID(b) {
		return false, nil
	}
	if a == b {
		return true, nil
	}
	_, err := Run(ctx, repo, "merge-base", "--is-ancestor", a, b)
	if err == nil {
		return true, nil
	}
	var ee *ExitError
	if errors.As(err, &ee) && (ee.Code == 1 || ee.Code == 128) {
		return false, nil
	}
	return false, err
}
