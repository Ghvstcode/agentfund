// Package lockfile reads, writes and authenticates tasks/MANIFEST.lock
// (spec/manifest.md §3), including the key rotation chain.
package lockfile

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"

	"github.com/ghvstcode/agentfund/worker/internal/app"
	"github.com/ghvstcode/agentfund/worker/internal/minisign"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
)

// Paths inside a project repo.
const (
	Path    = "tasks/MANIFEST.lock"
	SigPath = "tasks/MANIFEST.lock.minisig"
	Dir     = "tasks"

	// MaxRotations is the longest rotation chain a verifier follows.
	MaxRotations = 16
	// MaxLockBytes bounds the size of a lock file.
	MaxLockBytes = 4 << 20
)

// Entry lists one manifest.
type Entry struct {
	Path   string `json:"path"`
	ID     string `json:"id"`
	SHA256 string `json:"sha256"`
}

// Rotation is one link of the key rotation chain.
type Rotation struct {
	From      string `json:"from"`
	To        string `json:"to"`
	Signature string `json:"signature"`
}

// Lock is the decoded lock file.
type Lock struct {
	LockVersion int        `json:"lock_version"`
	SpecVersion int        `json:"spec_version"`
	Manifests   []Entry    `json:"manifests"`
	Rotations   []Rotation `json:"rotations"`
}

// SHA256Hex returns the lowercase hex SHA-256 of b.
func SHA256Hex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}

// Parse schema-validates and decodes lock bytes, and enforces the structural
// rules the schema cannot express: entries sorted by path, unique, and each
// id equal to its path stem.
func Parse(raw []byte) (*Lock, error) {
	if len(raw) > MaxLockBytes {
		return nil, errors.New("lock: file too large")
	}
	if err := spec.ValidateJSON(spec.SchemaLock, raw); err != nil {
		return nil, fmt.Errorf("lock: %w", err)
	}
	var l Lock
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(&l); err != nil {
		return nil, fmt.Errorf("lock: %w", err)
	}
	for i, e := range l.Manifests {
		id, ok := spec.IDFromPath(e.Path)
		if !ok || id != e.ID {
			return nil, fmt.Errorf("lock: entry %q has id %q which does not match its path", e.Path, e.ID)
		}
		if i > 0 && l.Manifests[i-1].Path >= e.Path {
			return nil, fmt.Errorf("lock: manifests must be sorted by path and unique (at %q)", e.Path)
		}
	}
	return &l, nil
}

// Marshal renders the lock the way `agentfund sign` writes it: two-space
// indentation, entries sorted by path, trailing newline.
func (l *Lock) Marshal() ([]byte, error) {
	out := *l
	out.Manifests = append([]Entry{}, l.Manifests...)
	sort.Slice(out.Manifests, func(i, j int) bool { return out.Manifests[i].Path < out.Manifests[j].Path })
	if out.Rotations == nil {
		out.Rotations = []Rotation{}
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// Find returns the entry for a manifest id.
func (l *Lock) Find(id string) (Entry, bool) {
	for _, e := range l.Manifests {
		if e.ID == id {
			return e, true
		}
	}
	return Entry{}, false
}

// RotationMessage is the exact byte string a rotation link signs.
func RotationMessage(from, to string) []byte {
	return []byte(app.RotationHeader + "\nfrom: " + from + "\nto: " + to + "\n")
}

// TrustedComment is the trusted comment `agentfund sign` writes.
func TrustedComment(pk minisign.PublicKey) string {
	return app.BinaryName + " lock v1 key:" + pk.KeyIDHex()
}

// NewRotation signs a rotation statement from the old key to the new key.
func NewRotation(old minisign.PrivateKey, to minisign.PublicKey) (Rotation, error) {
	from := old.Public().String()
	sig, err := minisign.Sign(old, RotationMessage(from, to.String()),
		app.BinaryName+" rotation v1 key:"+old.Public().KeyIDHex(), app.BinaryName+" key rotation")
	if err != nil {
		return Rotation{}, err
	}
	return Rotation{From: from, To: to.String(), Signature: string(sig)}, nil
}

// rotationsOnly leniently extracts the rotations array. The lock is not yet
// authenticated when this runs; each link authenticates itself from the pinned key.
func rotationsOnly(raw []byte) ([]Rotation, error) {
	var probe struct {
		Rotations []Rotation `json:"rotations"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		return nil, fmt.Errorf("lock: not valid JSON: %w", err)
	}
	return probe.Rotations, nil
}

// Authenticate verifies sig over the exact lock bytes against the pinned key
// P, following the rotation chain: it accepts when a sequence
// P = K0 → K1 → … → Kn (0 ≤ n ≤ 16) of entries in `rotations`, in order, each
// validly signed by its `from` key, ends at the key that signed the lock. No
// other key is ever accepted. It returns the signing key and the chain length.
func Authenticate(pinned minisign.PublicKey, raw, sig []byte) (signer minisign.PublicKey, links int, err error) {
	if len(raw) > MaxLockBytes {
		return signer, 0, errors.New("lock: file too large")
	}
	parsedSig, err := minisign.ParseSignature(sig)
	if err != nil {
		return signer, 0, err
	}
	rotations, err := rotationsOnly(raw)
	if err != nil {
		return signer, 0, err
	}
	if len(rotations) > MaxRotations {
		return signer, 0, fmt.Errorf("lock: %d rotation links exceed the maximum of %d", len(rotations), MaxRotations)
	}
	// reachable maps an encoded key to the shortest valid chain length from P.
	reachable := map[string]int{pinned.String(): 0}
	keys := map[string]minisign.PublicKey{pinned.String(): pinned}
	for _, r := range rotations {
		depth, ok := reachable[r.From]
		if !ok || depth+1 > MaxRotations {
			continue
		}
		to, perr := minisign.ParsePublicKey(r.To)
		if perr != nil {
			continue
		}
		if minisign.Verify(keys[r.From], RotationMessage(r.From, r.To), []byte(r.Signature)) != nil {
			continue
		}
		if cur, seen := reachable[r.To]; !seen || depth+1 < cur {
			reachable[r.To] = depth + 1
			keys[r.To] = to
		}
	}
	var firstErr error
	for enc, k := range keys {
		if k.ID != parsedSig.KeyID {
			continue
		}
		if verr := minisign.Verify(k, raw, sig); verr != nil {
			if firstErr == nil {
				firstErr = verr
			}
			continue
		}
		return k, reachable[enc], nil
	}
	if firstErr != nil {
		return signer, 0, firstErr
	}
	return signer, 0, fmt.Errorf("%w: lock is not signed by the pinned key %s or a key it rotated to",
		minisign.ErrKeyIDMismatch, pinned.Fingerprint())
}

// Build validates every manifest (path -> raw bytes, paths repo-relative
// "tasks/<id>.yaml") and returns the lock listing them, carrying over the
// given rotation chain. It also checks depends_on references and cycles.
func Build(manifests map[string][]byte, rotations []Rotation) (*Lock, error) {
	l := &Lock{LockVersion: 1, SpecVersion: spec.SpecVersion, Rotations: append([]Rotation{}, rotations...)}
	deps := map[string][]string{}
	for p, raw := range manifests {
		m, err := spec.ParseManifestAt(p, raw)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p, err)
		}
		deps[m.ID] = m.DependsOn
		l.Manifests = append(l.Manifests, Entry{Path: p, ID: m.ID, SHA256: SHA256Hex(raw)})
	}
	sort.Slice(l.Manifests, func(i, j int) bool { return l.Manifests[i].Path < l.Manifests[j].Path })
	if err := CheckDependencies(deps); err != nil {
		return nil, err
	}
	if len(l.Rotations) > MaxRotations {
		return nil, fmt.Errorf("lock: %d rotation links exceed the maximum of %d", len(l.Rotations), MaxRotations)
	}
	return l, nil
}

// CheckDependencies verifies that every depends_on id exists and that the
// dependency graph has no cycle (manifest.md §1).
func CheckDependencies(deps map[string][]string) error {
	ids := make([]string, 0, len(deps))
	for id := range deps {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		for _, d := range deps[id] {
			if _, ok := deps[d]; !ok {
				return fmt.Errorf("%s: depends_on unknown task %q", id, d)
			}
		}
	}
	const (
		white = iota
		grey
		black
	)
	state := map[string]int{}
	var visit func(id string, trail []string) error
	visit = func(id string, trail []string) error {
		switch state[id] {
		case black:
			return nil
		case grey:
			return fmt.Errorf("depends_on cycle: %s -> %s", joinTrail(trail), id)
		}
		state[id] = grey
		for _, d := range deps[id] {
			if err := visit(d, append(trail, id)); err != nil {
				return err
			}
		}
		state[id] = black
		return nil
	}
	for _, id := range ids {
		if err := visit(id, nil); err != nil {
			return err
		}
	}
	return nil
}

func joinTrail(t []string) string {
	out := ""
	for i, s := range t {
		if i > 0 {
			out += " -> "
		}
		out += s
	}
	return out
}

// SignLock marshals the lock and signs it, returning the lock bytes and the
// detached signature file.
func SignLock(l *Lock, key minisign.PrivateKey) (lockBytes, sig []byte, err error) {
	lockBytes, err = l.Marshal()
	if err != nil {
		return nil, nil, err
	}
	pk := key.Public()
	sig, err = minisign.Sign(key, lockBytes, TrustedComment(pk), "signature from "+app.BinaryName+" secret key "+pk.KeyIDHex())
	if err != nil {
		return nil, nil, err
	}
	return lockBytes, sig, nil
}
