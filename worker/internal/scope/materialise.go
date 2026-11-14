// Package scope decides what enters the sandbox and what may leave it.
//
// Entering: Plan/WriteTar turn the git tree at the claimed commit into a tar
// stream with host-chosen ownership and modes (no .git, no manifests, no
// agentfund.yaml, scope.read applied).
//
// Leaving: Diff reads the tar stream of the sandbox working tree in memory
// and derives the change set against the same baseline, refusing anything
// outside scope.write. Both directions are security boundaries: nothing from
// the sandbox is ever extracted to the host filesystem.
package scope

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"path"
	"sort"
	"strings"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/gitx"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

// Sandbox identities (must match images/sandbox/Dockerfile).
const (
	AgentUID = 10001
	AgentGID = 10001
)

// Git file modes.
const (
	ModeFile    = "100644"
	ModeExec    = "100755"
	ModeSymlink = "120000"
	ModeGitlink = "160000"
)

// File is one baseline entry materialised in the sandbox.
type File struct {
	Path string
	Mode string // ModeFile, ModeExec or ModeSymlink
	OID  string
	// Link is the symlink target (ModeSymlink only).
	Link string
}

// Plan is the materialisation plan and, at the same time, the baseline the
// post-run diff compares against.
type Plan struct {
	Files   []File
	Dropped int // entries of the commit that are not materialised
	Write   []string
	byPath  map[string]File
}

// Lookup finds a baseline entry.
func (p *Plan) Lookup(pth string) (File, bool) { f, ok := p.byPath[pth]; return f, ok }

// CheckPath validates a repo-relative path coming from an untrusted source.
func CheckPath(p string) error {
	if p == "" || len(p) > 4096 {
		return fmt.Errorf("empty or overlong path")
	}
	if strings.ContainsAny(p, "\x00\\") {
		return fmt.Errorf("path contains NUL or backslash")
	}
	if strings.HasPrefix(p, "/") || path.Clean(p) != p {
		return fmt.Errorf("path is absolute or not clean")
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return fmt.Errorf("path has an empty, '.' or '..' segment")
		}
		if isDotGit(seg) {
			return fmt.Errorf("path addresses a .git directory")
		}
	}
	return nil
}

// isDotGit recognises ".git" and the spellings that alias it on
// case-insensitive, HFS+ and NTFS file systems.
func isDotGit(seg string) bool {
	s := strings.ToLower(strings.TrimRight(seg, ". "))
	// Strip zero-width and other ignorable code points HFS+ drops.
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 0x200c && r <= 0x200f, r >= 0x202a && r <= 0x202e, r >= 0x206a && r <= 0x206f, r == 0xfeff:
			return -1
		}
		return r
	}, s)
	return s == ".git" || strings.HasPrefix(s, "git~")
}

// NewPlan filters the commit's tree for the sandbox: manifests and the
// project descriptor are always removed; with scope.read set, everything that
// matches neither read nor write globs is removed; submodules are skipped.
func NewPlan(ctx context.Context, entries []gitx.TreeEntry, m *spec.Manifest, readLink func(ctx context.Context, oid string) ([]byte, error)) (*Plan, error) {
	p := &Plan{Write: m.Scope.Write, byPath: map[string]File{}}
	for _, e := range entries {
		if err := CheckPath(e.Path); err != nil {
			return nil, fmt.Errorf("repository path %q: %w", e.Path, err)
		}
		if e.Path == "agentfund.yaml" || strings.HasPrefix(e.Path, "tasks/") {
			p.Dropped++
			continue
		}
		if m.ReadSet && !spec.MatchAny(m.Scope.Read, e.Path) && !spec.MatchAny(m.Scope.Write, e.Path) {
			p.Dropped++
			continue
		}
		f := File{Path: e.Path, Mode: e.Mode, OID: e.OID}
		switch {
		case e.Type == "blob" && (e.Mode == ModeFile || e.Mode == ModeExec):
		case e.Type == "blob" && e.Mode == ModeSymlink:
			target, err := readLink(ctx, e.OID)
			if err != nil {
				return nil, fmt.Errorf("read symlink %s: %w", e.Path, err)
			}
			f.Link = string(target)
		case e.Mode == ModeGitlink:
			p.Dropped++
			continue
		default:
			return nil, fmt.Errorf("repository entry %s has unsupported mode %s", e.Path, e.Mode)
		}
		p.Files = append(p.Files, f)
		p.byPath[f.Path] = f
	}
	sort.Slice(p.Files, func(i, j int) bool { return p.Files[i].Path < p.Files[j].Path })
	return p, nil
}

// dirTakesWrites reports whether glob g can match a file placed directly in
// directory d ("" = root).
func dirTakesWrites(g, d string) bool {
	segs := strings.Split(g, "/")
	if segs[len(segs)-1] != "**" {
		segs[len(segs)-1] = "x"
	}
	probe := "x"
	if d != "" {
		probe = d + "/x"
	}
	return spec.MatchAny([]string{strings.Join(segs, "/")}, probe)
}

// WritableDirs returns the directories (repo-relative, "" = root) the agent
// must be able to create files in: the literal prefix directory of every
// write glob (created if missing) plus every baseline directory in which a
// write glob could match a new file. Never-writable trees are excluded.
func (p *Plan) WritableDirs() map[string]bool {
	out := map[string]bool{}
	dirs := map[string]bool{"": true}
	for _, f := range p.Files {
		for d := path.Dir(f.Path); d != "." && !dirs[d]; d = path.Dir(d) {
			dirs[d] = true
		}
	}
	for _, g := range p.Write {
		prefix, _ := spec.LiteralPrefixDir(g)
		if prefix == "" || !spec.NeverWritable(prefix) {
			out[prefix] = true
		}
		for d := range dirs {
			if d != "" && spec.NeverWritable(d) {
				continue
			}
			if dirTakesWrites(g, d) {
				out[d] = true
			}
		}
	}
	return out
}

// RootWritable reports whether the working-tree root itself must be writable.
func (p *Plan) RootWritable() bool { return p.WritableDirs()[""] }

var epoch = time.Unix(0, 0)

// WriteTar streams the plan as a tar archive to be unpacked at the sandbox
// working directory. The tree is owned by root and read-only to the agent;
// files matching scope.write are owned by the agent; writable directories are
// root-owned with mode 1777 (sticky), so the agent can add files but cannot
// remove or replace files it does not own.
func (p *Plan) WriteTar(ctx context.Context, w io.Writer, readBlob func(ctx context.Context, oid string) ([]byte, error)) error {
	tw := tar.NewWriter(w)
	writable := p.WritableDirs()

	dirSet := map[string]bool{}
	for d := range writable {
		for ; d != "" && d != "."; d = path.Dir(d) {
			dirSet[d] = true
		}
	}
	for _, f := range p.Files {
		for d := path.Dir(f.Path); d != "." && !dirSet[d]; d = path.Dir(d) {
			dirSet[d] = true
		}
	}
	dirs := make([]string, 0, len(dirSet))
	for d := range dirSet {
		dirs = append(dirs, d)
	}
	sort.Strings(dirs)
	for _, d := range dirs {
		mode := int64(0o755)
		if writable[d] {
			mode = 0o1777
		}
		if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeDir, Name: d + "/", Mode: mode, Uid: 0, Gid: 0, ModTime: epoch, Format: tar.FormatPAX}); err != nil {
			return err
		}
	}
	for _, f := range p.Files {
		if err := ctx.Err(); err != nil {
			return err
		}
		if f.Mode == ModeSymlink {
			if err := tw.WriteHeader(&tar.Header{Typeflag: tar.TypeSymlink, Name: f.Path, Linkname: f.Link, Mode: 0o777, ModTime: epoch, Format: tar.FormatPAX}); err != nil {
				return err
			}
			continue
		}
		data, err := readBlob(ctx, f.OID)
		if err != nil {
			return fmt.Errorf("read %s: %w", f.Path, err)
		}
		h := &tar.Header{Typeflag: tar.TypeReg, Name: f.Path, Size: int64(len(data)), Mode: 0o644, ModTime: epoch, Format: tar.FormatPAX}
		if f.Mode == ModeExec {
			h.Mode = 0o755
		}
		if spec.Writable(p.Write, f.Path) {
			h.Uid, h.Gid = AgentUID, AgentGID
		}
		if err := tw.WriteHeader(h); err != nil {
			return err
		}
		if _, err := tw.Write(data); err != nil {
			return err
		}
	}
	return tw.Close()
}
