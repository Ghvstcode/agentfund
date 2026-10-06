package gitx

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// IgnoreChecker answers "does the repository's .gitignore (at one commit)
// ignore this untracked path?" without checking the repository out. Only the
// commit's .gitignore files are materialised, into a private temp directory.
type IgnoreChecker struct {
	repo, dir string
}

// NewIgnoreChecker prepares a checker for the given commit.
func NewIgnoreChecker(ctx context.Context, repo, commit string) (*IgnoreChecker, error) {
	entries, err := LsTree(ctx, repo, commit, "", true)
	if err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp("", "ignore-*")
	if err != nil {
		return nil, err
	}
	ic := &IgnoreChecker{repo: repo, dir: dir}
	root, err := os.OpenRoot(dir)
	if err != nil {
		ic.Close()
		return nil, err
	}
	defer root.Close()
	for _, e := range entries {
		if !e.IsRegular() || (e.Path != ".gitignore" && !strings.HasSuffix(e.Path, "/.gitignore")) {
			continue
		}
		data, err := ReadBlob(ctx, repo, e.OID)
		if err != nil {
			ic.Close()
			return nil, err
		}
		if d := filepath.Dir(filepath.FromSlash(e.Path)); d != "." {
			if err := root.MkdirAll(d, 0o755); err != nil {
				ic.Close()
				return nil, fmt.Errorf("prepare ignore rules: %w", err)
			}
		}
		if err := root.WriteFile(filepath.FromSlash(e.Path), data, 0o644); err != nil {
			ic.Close()
			return nil, fmt.Errorf("prepare ignore rules: %w", err)
		}
	}
	return ic, nil
}

// Close removes the temp directory.
func (ic *IgnoreChecker) Close() { _ = os.RemoveAll(ic.dir) }

// Ignored returns the subset of paths that are ignored.
func (ic *IgnoreChecker) Ignored(ctx context.Context, paths []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(paths) == 0 {
		return out, nil
	}
	var in bytes.Buffer
	for _, p := range paths {
		if strings.ContainsRune(p, 0) {
			return nil, fmt.Errorf("path contains NUL")
		}
		in.WriteString(p)
		in.WriteByte(0)
	}
	abs, err := filepath.Abs(ic.repo)
	if err != nil {
		return nil, err
	}
	gitDir := abs
	if st, err := os.Stat(filepath.Join(abs, ".git")); err == nil && st.IsDir() {
		gitDir = filepath.Join(abs, ".git")
	}
	res, err := Cmd{
		Dir:    ic.dir,
		Args:   []string{"--git-dir=" + gitDir, "--work-tree=" + ic.dir, "check-ignore", "--no-index", "-z", "--stdin"},
		Config: []string{"core.excludesFile=/dev/null", "core.quotePath=false"},
		Stdin:  &in,
	}.Run(ctx)
	if err != nil {
		var ee *ExitError
		if errors.As(err, &ee) && ee.Code == 1 { // none ignored
			return out, nil
		}
		return nil, err
	}
	for _, p := range bytes.Split(res, []byte{0}) {
		if len(p) > 0 {
			out[string(p)] = true
		}
	}
	return out, nil
}

// TreeChange is one path to set or remove when building a commit.
type TreeChange struct {
	Path    string
	Delete  bool
	Mode    string // "100644" or "100755"
	Content []byte
}

// CommitSpec describes a commit built with plumbing only.
type CommitSpec struct {
	Parent      string
	Changes     []TreeChange
	Message     string
	AuthorName  string
	AuthorEmail string
}

// BuildCommit creates a commit on top of Parent applying Changes, without a
// working tree: blobs are written with hash-object, the tree is assembled in
// a private index. No repository content ever touches the host file system,
// and git itself refuses path spellings that alias .git.
func BuildCommit(ctx context.Context, repo string, cs CommitSpec) (string, error) {
	if !IsFullOID(cs.Parent) {
		return "", fmt.Errorf("build commit: bad parent %q", cs.Parent)
	}
	tmp, err := os.MkdirTemp("", "index-*")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(tmp)
	env := []string{"GIT_INDEX_FILE=" + filepath.Join(tmp, "index")}
	cfg := []string{"core.protectHFS=true", "core.protectNTFS=true"}
	if _, err := (Cmd{Dir: repo, Args: []string{"read-tree", cs.Parent}, Env: env, Config: cfg}).Run(ctx); err != nil {
		return "", err
	}
	var info bytes.Buffer
	for _, c := range cs.Changes {
		if c.Path == "" || strings.ContainsAny(c.Path, "\x00\n\t") {
			return "", fmt.Errorf("build commit: unusable path %q", c.Path)
		}
		if c.Delete {
			fmt.Fprintf(&info, "0 %s\t%s\x00", strings.Repeat("0", len(cs.Parent)), c.Path)
			continue
		}
		if c.Mode != "100644" && c.Mode != "100755" {
			return "", fmt.Errorf("build commit: %s has unsupported mode %q", c.Path, c.Mode)
		}
		oid, err := Cmd{Dir: repo, Args: []string{"hash-object", "-w", "--stdin"}, Stdin: bytes.NewReader(c.Content)}.Run(ctx)
		if err != nil {
			return "", err
		}
		fmt.Fprintf(&info, "%s %s\t%s\x00", c.Mode, strings.TrimSpace(string(oid)), c.Path)
	}
	if _, err := (Cmd{Dir: repo, Args: []string{"update-index", "-z", "--index-info"}, Env: env, Config: cfg, Stdin: &info}).Run(ctx); err != nil {
		return "", err
	}
	tree, err := Cmd{Dir: repo, Args: []string{"write-tree"}, Env: env, Config: cfg}.Run(ctx)
	if err != nil {
		return "", err
	}
	parentTree, err := Run(ctx, repo, "rev-parse", cs.Parent+"^{tree}")
	if err != nil {
		return "", err
	}
	if bytes.Equal(bytes.TrimSpace(tree), bytes.TrimSpace(parentTree)) {
		return "", ErrNoChanges
	}
	ident := []string{
		"GIT_AUTHOR_NAME=" + cs.AuthorName, "GIT_AUTHOR_EMAIL=" + cs.AuthorEmail,
		"GIT_COMMITTER_NAME=" + cs.AuthorName, "GIT_COMMITTER_EMAIL=" + cs.AuthorEmail,
	}
	sha, err := Cmd{
		Dir: repo, Args: []string{"commit-tree", strings.TrimSpace(string(tree)), "-p", cs.Parent, "-F", "-"},
		Env: ident, Stdin: strings.NewReader(cs.Message),
	}.Run(ctx)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(sha)), nil
}

// ErrNoChanges means the commit would be empty.
var ErrNoChanges = errors.New("no changes to commit")
