// Package verify implements the verification chain of spec/manifest.md §4,
// steps 1–4, as a pure library over a git repository on disk. It never reads
// a checked-out file: everything is read from git objects at the claimed
// commit, and the only key it trusts is the one the donor pinned.
package verify

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/agentfund/agentfund/worker/internal/gitx"
	"github.com/agentfund/agentfund/worker/internal/lockfile"
	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/spec"
)

// Step identifies which step of the chain refused.
type Step int

// Steps of manifest.md §4.
const (
	StepFetch     Step = 1
	StepSignature Step = 2
	StepContent   Step = 3
	StepApproval  Step = 4
)

func (s Step) String() string {
	switch s {
	case StepFetch:
		return "fetch"
	case StepSignature:
		return "signature"
	case StepContent:
		return "content"
	case StepApproval:
		return "approval"
	}
	return "unknown"
}

// Error is a verification refusal.
type Error struct {
	Step Step
	Msg  string
	Err  error
}

func (e *Error) Error() string {
	s := fmt.Sprintf("verification failed at step %d (%s): %s", int(e.Step), e.Step, e.Msg)
	if e.Err != nil {
		s += ": " + e.Err.Error()
	}
	return s
}

func (e *Error) Unwrap() error { return e.Err }

func fail(step Step, err error, format string, a ...any) error {
	return &Error{Step: step, Msg: fmt.Sprintf(format, a...), Err: err}
}

// Approval is what the donor pinned with `agentfund approve`.
type Approval struct {
	Pubkey             string // minisign-encoded maintainer key
	ApprovedCommit     string
	ApprovedLockSHA256 string
}

// Policy holds the two approval-following switches; both default to off.
type Policy struct {
	FollowUnchangedLock     bool
	AutoFollowSignedUpdates bool
}

// LockResult is the outcome of steps 2–3 for the whole task set at a commit.
type LockResult struct {
	Commit     string
	Lock       *lockfile.Lock
	LockRaw    []byte
	LockSHA256 string
	Signer     minisign.PublicKey
	Rotations  int // links followed from the pinned key to the signer
	// blobs maps manifest path to blob object id at the commit.
	blobs  map[string]string
	hashes map[string]string
	src    source
}

// Request asks whether one claimed task may run.
type Request struct {
	RepoDir     string
	Commit      string // C, from the claim
	TaskID      string // manifest id (not slug-qualified)
	ContentHash string // H, from the claim
	Approval    Approval
	Policy      Policy
}

// Basis says why step 4 accepted the commit.
type Basis string

// Approval bases.
const (
	BasisApproved      Basis = "approved-commit"
	BasisAncestor      Basis = "ancestor-of-approved"
	BasisUnchangedLock Basis = "follow-unchanged-lock"
	BasisAutoFollow    Basis = "auto-follow-signed-updates"
)

// Result is a verified task.
type Result struct {
	LockResult
	Manifest     *spec.Manifest
	ManifestRaw  []byte
	ManifestPath string
	Basis        Basis
}

// source abstracts "the tree at commit C" so the chain can be exercised
// without git in tests. The production implementation reads git objects.
type source interface {
	// list returns the direct children of tasks/.
	list(ctx context.Context) ([]gitx.TreeEntry, error)
	read(ctx context.Context, oid string) ([]byte, error)
}

type gitSource struct{ repo, commit string }

func (g gitSource) list(ctx context.Context) ([]gitx.TreeEntry, error) {
	return gitx.LsTree(ctx, g.repo, g.commit, lockfile.Dir, false)
}
func (g gitSource) read(ctx context.Context, oid string) ([]byte, error) {
	return gitx.ReadBlob(ctx, g.repo, oid)
}

// Lock runs steps 1–3 for the task set at commit: the commit exists, the
// lock's signature chains to the pinned key, the lock is schema-valid and
// lists exactly the tasks/*.yaml files of the commit with matching hashes.
func Lock(ctx context.Context, repoDir, commit, pinnedKey string) (*LockResult, error) {
	// Step 1.
	if !gitx.IsFullSHA1(commit) {
		return nil, fail(StepFetch, nil, "commit %q is not a full 40-hex commit id", commit)
	}
	if !gitx.CommitExists(ctx, repoDir, commit) {
		return nil, fail(StepFetch, nil, "commit %s does not exist in the repository", commit)
	}
	return lockFrom(ctx, gitSource{repoDir, commit}, commit, pinnedKey)
}

func lockFrom(ctx context.Context, src source, commit, pinnedKey string) (*LockResult, error) {
	pinned, err := minisign.ParsePublicKey(pinnedKey)
	if err != nil {
		return nil, fail(StepSignature, err, "pinned public key is unusable")
	}

	entries, err := src.list(ctx)
	if err != nil {
		return nil, fail(StepSignature, err, "cannot list %s/ at %s", lockfile.Dir, commit)
	}
	byPath := map[string]gitx.TreeEntry{}
	for _, e := range entries {
		byPath[e.Path] = e
	}
	readRegular := func(p string) ([]byte, error) {
		e, ok := byPath[p]
		if !ok {
			return nil, fmt.Errorf("%s is missing at %s", p, commit)
		}
		if !e.IsRegular() {
			return nil, fmt.Errorf("%s is not a regular file (mode %s)", p, e.Mode)
		}
		return src.read(ctx, e.OID)
	}

	// Step 2.
	lockRaw, err := readRegular(lockfile.Path)
	if err != nil {
		return nil, fail(StepSignature, err, "cannot read lock")
	}
	sigRaw, err := readRegular(lockfile.SigPath)
	if err != nil {
		return nil, fail(StepSignature, err, "cannot read lock signature")
	}
	signer, links, err := lockfile.Authenticate(pinned, lockRaw, sigRaw)
	if err != nil {
		return nil, fail(StepSignature, err, "lock signature does not verify against pinned key %s", pinned.Fingerprint())
	}

	// Step 3.
	lock, err := lockfile.Parse(lockRaw)
	if err != nil {
		return nil, fail(StepContent, err, "lock is invalid")
	}
	res := &LockResult{
		Commit: commit, Lock: lock, LockRaw: lockRaw, LockSHA256: lockfile.SHA256Hex(lockRaw),
		Signer: signer, Rotations: links, blobs: map[string]string{}, hashes: map[string]string{}, src: src,
	}
	listed := map[string]lockfile.Entry{}
	for _, e := range lock.Manifests {
		listed[e.Path] = e
	}
	for _, e := range entries {
		if !strings.HasSuffix(e.Path, ".yaml") {
			continue
		}
		le, ok := listed[e.Path]
		if !ok {
			return nil, fail(StepContent, nil, "manifest %s is present at %s but not listed in the lock", e.Path, commit)
		}
		if !e.IsRegular() {
			return nil, fail(StepContent, nil, "manifest %s is not a regular file (mode %s)", e.Path, e.Mode)
		}
		raw, err := src.read(ctx, e.OID)
		if err != nil {
			return nil, fail(StepContent, err, "cannot read manifest %s", e.Path)
		}
		if got := lockfile.SHA256Hex(raw); got != le.SHA256 {
			return nil, fail(StepContent, nil, "manifest %s hashes to %s but the lock says %s", e.Path, got, le.SHA256)
		}
		res.blobs[e.Path] = e.OID
		res.hashes[e.Path] = le.SHA256
	}
	for p := range listed {
		if _, ok := res.blobs[p]; !ok {
			return nil, fail(StepContent, nil, "lock lists %s but the file does not exist at %s", p, commit)
		}
	}
	return res, nil
}

// ReadManifest returns the raw bytes and parsed form of a listed manifest.
// The bytes were hash-checked against the lock by Lock.
func (r *LockResult) ReadManifest(ctx context.Context, id string) ([]byte, *spec.Manifest, error) {
	p := spec.ManifestPath(id)
	oid, ok := r.blobs[p]
	if !ok {
		return nil, nil, fmt.Errorf("task %s is not in the lock", id)
	}
	raw, err := r.src.read(ctx, oid)
	if err != nil {
		return nil, nil, err
	}
	if got, want := lockfile.SHA256Hex(raw), r.hashes[p]; got != want {
		return nil, nil, fmt.Errorf("manifest %s changed underneath verification", p)
	}
	m, err := spec.ParseManifestAt(p, raw)
	if err != nil {
		return raw, nil, err
	}
	return raw, m, nil
}

// Task runs steps 1–4 for one claimed task. A nil error means the manifest in
// the result is authentic, is the one the claim named, and sits at a commit
// the donor's approval covers.
func Task(ctx context.Context, req Request) (*Result, error) {
	lr, err := Lock(ctx, req.RepoDir, req.Commit, req.Approval.Pubkey)
	if err != nil {
		return nil, err
	}
	res, err := taskFrom(ctx, lr, req.TaskID, req.ContentHash)
	if err != nil {
		return nil, err
	}
	basis, err := approve(ctx, req, lr)
	if err != nil {
		return nil, err
	}
	res.Basis = basis
	return res, nil
}

// taskFrom is the task-specific half of step 3.
func taskFrom(ctx context.Context, lr *LockResult, taskID, contentHash string) (*Result, error) {
	entry, ok := lr.Lock.Find(taskID)
	if !ok {
		return nil, fail(StepContent, nil, "task %s is not listed in the lock at %s", taskID, lr.Commit)
	}
	if contentHash == "" || entry.SHA256 != contentHash {
		return nil, fail(StepContent, nil, "claim names content hash %q but the signed lock lists %s for %s",
			contentHash, entry.SHA256, taskID)
	}
	raw, m, err := lr.ReadManifest(ctx, taskID)
	if err != nil {
		return nil, fail(StepContent, err, "manifest %s is invalid", entry.Path)
	}
	return &Result{LockResult: *lr, Manifest: m, ManifestRaw: raw, ManifestPath: entry.Path}, nil
}

func approve(ctx context.Context, req Request, lr *LockResult) (Basis, error) {
	return approval(ctx, req.RepoDir, req.Commit, req.Approval, req.Policy, func() string { return lr.LockSHA256 })
}

// Approved runs only step 4 for a commit: is it covered by the donor's
// approval (the approved commit, an ancestor, or a follow policy)? It is used
// before claiming, so that a project whose pin moved past the approval is
// skipped instead of claimed and refused. It does not check signatures — the
// full chain still runs against the claim.
func Approved(ctx context.Context, repoDir, commit string, a Approval, pol Policy) (Basis, error) {
	if !gitx.IsFullSHA1(commit) || !gitx.CommitExists(ctx, repoDir, commit) {
		return "", fail(StepFetch, nil, "commit %q does not exist in the repository", commit)
	}
	return approval(ctx, repoDir, commit, a, pol, func() string {
		entries, err := gitx.LsTree(ctx, repoDir, commit, lockfile.Dir, false)
		if err != nil {
			return ""
		}
		for _, e := range entries {
			if e.Path == lockfile.Path && e.IsRegular() {
				if raw, err := gitx.ReadBlob(ctx, repoDir, e.OID); err == nil {
					return lockfile.SHA256Hex(raw)
				}
			}
		}
		return ""
	})
}

// IsApprovalError reports whether err is a step-4 refusal.
func IsApprovalError(err error) bool {
	var ve *Error
	return errors.As(err, &ve) && ve.Step == StepApproval
}

func approval(ctx context.Context, repoDir, commit string, a Approval, pol Policy, lockSHA func() string) (Basis, error) {
	req := Request{RepoDir: repoDir, Commit: commit, Policy: pol}
	if !gitx.IsFullSHA1(a.ApprovedCommit) {
		return "", fail(StepApproval, nil, "approval record has no valid approved commit; run `approve` again")
	}
	if req.Commit == a.ApprovedCommit {
		return BasisApproved, nil
	}
	anc, err := gitx.IsAncestor(ctx, req.RepoDir, req.Commit, a.ApprovedCommit)
	if err != nil {
		return "", fail(StepApproval, err, "cannot relate %s to approved commit %s", req.Commit, a.ApprovedCommit)
	}
	if anc {
		return BasisAncestor, nil
	}
	if req.Policy.FollowUnchangedLock && a.ApprovedLockSHA256 != "" && lockSHA() == a.ApprovedLockSHA256 {
		return BasisUnchangedLock, nil
	}
	if req.Policy.AutoFollowSignedUpdates {
		return BasisAutoFollow, nil
	}
	return "", fail(StepApproval, nil,
		"commit %s is not the approved commit %s nor one of its ancestors, and no follow policy accepts it; review and run `approve` again",
		req.Commit, a.ApprovedCommit)
}

// IsVerificationError reports whether err is a refusal from this package.
func IsVerificationError(err error) bool {
	var ve *Error
	return errors.As(err, &ve)
}
