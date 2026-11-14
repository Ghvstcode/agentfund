package scope

import (
	"archive/tar"
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"sort"
	"strings"

	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

// Kind classifies a change.
type Kind string

// Change kinds.
const (
	Added       Kind = "added"
	Modified    Kind = "modified"
	Deleted     Kind = "deleted"
	ModeChanged Kind = "mode"
)

// Change is one accepted change inside scope.write.
type Change struct {
	Path    string
	Kind    Kind
	Mode    string // ModeFile or ModeExec ("" for Deleted)
	Content []byte // nil for Deleted
}

// Limits bound what a run may produce.
type Limits struct {
	MaxFileBytes  int64
	MaxTotalBytes int64
	MaxEntries    int
}

// DefaultLimits are the caps applied by the pipeline.
var DefaultLimits = Limits{MaxFileBytes: 5 << 20, MaxTotalBytes: 50 << 20, MaxEntries: 200_000}

// Violation is a scope refusal: the whole run must be discarded.
type Violation struct {
	Path   string
	Reason string
}

func (v *Violation) Error() string {
	if v.Path == "" {
		return "scope violation: " + v.Reason
	}
	return fmt.Sprintf("scope violation: %q: %s", v.Path, v.Reason)
}

func violation(p, format string, a ...any) error {
	if len(p) > 200 {
		p = p[:200] + "…"
	}
	return &Violation{Path: p, Reason: fmt.Sprintf(format, a...)}
}

// IsViolation reports whether err is a scope violation.
func IsViolation(err error) bool {
	var v *Violation
	return errors.As(err, &v)
}

// IgnoreFunc reports which of the given untracked paths the repository's
// .gitignore rules (at the claimed commit) ignore.
type IgnoreFunc func(paths []string) (map[string]bool, error)

func blobOID(oidLen int, data []byte) string {
	var h hash.Hash
	if oidLen == 64 {
		h = sha256.New()
	} else {
		h = sha1.New()
	}
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// streamMatches hashes size bytes from r as a git blob without buffering them.
func streamMatches(r io.Reader, size int64, oid string) (bool, error) {
	var h hash.Hash
	if len(oid) == 64 {
		h = sha256.New()
	} else {
		h = sha1.New()
	}
	fmt.Fprintf(h, "blob %d\x00", size)
	n, err := io.Copy(h, io.LimitReader(r, size))
	if err != nil || n != size {
		return false, fmt.Errorf("short read")
	}
	return hex.EncodeToString(h.Sum(nil)) == oid, nil
}

// Diff reads the tar stream of the sandbox working tree (entries named
// "<root>/<repo path>", as produced by `docker cp <container>:/<root> -`) and
// returns the change set relative to the plan's baseline.
//
// It returns a *Violation — and the caller must discard the run — when any
// added, modified, deleted or mode-changed path is outside scope.write or
// never-writable, when any entry is a symlink, hard link, device, FIFO or
// other non-regular file that is not an untouched baseline symlink, when a
// name is unclean ("..", absolute, NUL, backslash, .git aliases), on
// duplicate entries, or when size limits are exceeded. Untracked paths the
// repository ignores (.gitignore at the claimed commit) are skipped, except
// under never-writable locations. Nothing is written to disk.
func Diff(r io.Reader, root string, plan *Plan, ignored IgnoreFunc, lim Limits) ([]Change, error) {
	tr := tar.NewReader(r)
	seen := map[string]bool{}    // every archive name, to refuse duplicates
	present := map[string]bool{} // baseline paths still present as file/symlink
	var (
		changes     []Change
		total       int64
		entries     int
		pendingOut  []string            // added, outside scope: violation unless ignored
		pendingBig  = map[string]bool{} // added, in scope, too large to keep: violation unless ignored
		addedInside = map[string]int{}  // path -> index into changes
	)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, violation("", "unreadable archive from sandbox: %v", err)
		}
		entries++
		if lim.MaxEntries > 0 && entries > lim.MaxEntries {
			return nil, violation("", "more than %d entries in the working tree", lim.MaxEntries)
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		name := strings.TrimSuffix(h.Name, "/")
		if name == root {
			if h.Typeflag != tar.TypeDir {
				return nil, violation(h.Name, "working tree root is not a directory")
			}
			continue
		}
		rel, ok := strings.CutPrefix(name, root+"/")
		if !ok {
			return nil, violation(h.Name, "entry is outside the working tree")
		}
		if err := CheckPath(rel); err != nil {
			return nil, violation(h.Name, "%v", err)
		}
		if seen[rel] {
			return nil, violation(rel, "duplicate archive entry")
		}
		seen[rel] = true
		base, tracked := plan.Lookup(rel)

		switch h.Typeflag {
		case tar.TypeDir:
			// A baseline file or symlink replaced by a directory counts as deleted
			// (it is simply not marked present).
			continue
		case tar.TypeSymlink:
			if tracked && base.Mode == ModeSymlink && base.Link == h.Linkname {
				present[rel] = true
				continue
			}
			return nil, violation(rel, "symlinks may not be created or changed")
		case tar.TypeReg:
		default:
			return nil, violation(rel, "non-regular file (tar type %q): hard links, devices, FIFOs and sockets are not allowed", string(h.Typeflag))
		}
		if h.Size < 0 {
			return nil, violation(rel, "negative size")
		}
		mode := ModeFile
		if h.Mode&0o111 != 0 {
			mode = ModeExec
		}
		inScope := spec.Writable(plan.Write, rel)
		never := spec.NeverWritable(rel)

		if !tracked {
			switch {
			case never:
				return nil, violation(rel, "never-writable path was created")
			case !inScope:
				pendingOut = append(pendingOut, rel)
			case h.Size > lim.MaxFileBytes || total+h.Size > lim.MaxTotalBytes:
				pendingBig[rel] = true
			default:
				data, err := io.ReadAll(io.LimitReader(tr, h.Size+1))
				if err != nil || int64(len(data)) != h.Size {
					return nil, violation(rel, "archive entry is truncated or inconsistent")
				}
				total += h.Size
				addedInside[rel] = len(changes)
				changes = append(changes, Change{Path: rel, Kind: Added, Mode: mode, Content: data})
			}
			continue
		}

		// Tracked path.
		present[rel] = true
		if base.Mode == ModeSymlink {
			return nil, violation(rel, "a tracked symlink was replaced by a file")
		}
		if h.Size > lim.MaxFileBytes {
			// Too large to keep: hash it as a stream; it is fine only if untouched.
			same, err := streamMatches(tr, h.Size, base.OID)
			if err != nil {
				return nil, violation(rel, "archive entry is truncated or inconsistent")
			}
			if same && mode == base.Mode {
				continue
			}
			if !inScope || never {
				return nil, violation(rel, "file outside scope.write was modified")
			}
			return nil, violation(rel, "file is larger than %d bytes", lim.MaxFileBytes)
		}
		data, err := io.ReadAll(io.LimitReader(tr, h.Size+1))
		if err != nil || int64(len(data)) != h.Size {
			return nil, violation(rel, "archive entry is truncated or inconsistent")
		}
		sameContent := blobOID(len(base.OID), data) == base.OID
		if sameContent && mode == base.Mode {
			continue
		}
		if never {
			return nil, violation(rel, "never-writable path was modified")
		}
		if !inScope {
			if sameContent {
				return nil, violation(rel, "mode of a file outside scope.write was changed")
			}
			return nil, violation(rel, "file outside scope.write was modified")
		}
		if total+h.Size > lim.MaxTotalBytes {
			return nil, violation(rel, "changes exceed %d bytes in total", lim.MaxTotalBytes)
		}
		total += h.Size
		kind := Modified
		if sameContent {
			kind = ModeChanged
		}
		changes = append(changes, Change{Path: rel, Kind: kind, Mode: mode, Content: data})
	}

	// Deletions: baseline entries that are no longer present.
	for _, f := range plan.Files {
		if present[f.Path] {
			continue
		}
		if spec.NeverWritable(f.Path) {
			return nil, violation(f.Path, "never-writable path was deleted")
		}
		if !spec.Writable(plan.Write, f.Path) {
			return nil, violation(f.Path, "file outside scope.write was deleted")
		}
		changes = append(changes, Change{Path: f.Path, Kind: Deleted})
	}

	// Untracked additions: consult the repository's ignore rules once.
	var ask []string
	ask = append(ask, pendingOut...)
	for p := range pendingBig {
		ask = append(ask, p)
	}
	for p := range addedInside {
		ask = append(ask, p)
	}
	sort.Strings(ask)
	ign := map[string]bool{}
	if len(ask) > 0 && ignored != nil {
		var err error
		if ign, err = ignored(ask); err != nil {
			return nil, fmt.Errorf("consult ignore rules: %w", err)
		}
	}
	sort.Strings(pendingOut)
	for _, p := range pendingOut {
		if !ign[p] {
			return nil, violation(p, "file outside scope.write was created")
		}
	}
	bigs := make([]string, 0, len(pendingBig))
	for p := range pendingBig {
		bigs = append(bigs, p)
	}
	sort.Strings(bigs)
	for _, p := range bigs {
		if !ign[p] {
			return nil, violation(p, "new file exceeds the size limits (%d bytes per file, %d bytes in total)", lim.MaxFileBytes, lim.MaxTotalBytes)
		}
	}
	kept := changes[:0]
	for _, c := range changes {
		if c.Kind == Added && ign[c.Path] {
			continue
		}
		kept = append(kept, c)
	}
	sort.Slice(kept, func(i, j int) bool { return kept[i].Path < kept[j].Path })
	return kept, nil
}

// Summary renders a change set for logs and PR bodies.
func Summary(changes []Change) string {
	var b bytes.Buffer
	for _, c := range changes {
		switch c.Kind {
		case Deleted:
			fmt.Fprintf(&b, "D %s\n", c.Path)
		case Added:
			fmt.Fprintf(&b, "A %s (%d bytes)\n", c.Path, len(c.Content))
		case ModeChanged:
			fmt.Fprintf(&b, "T %s (%s)\n", c.Path, c.Mode)
		default:
			fmt.Fprintf(&b, "M %s (%d bytes)\n", c.Path, len(c.Content))
		}
	}
	return b.String()
}
