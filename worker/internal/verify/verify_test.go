package verify

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	upstream "aead.dev/minisign"

	"github.com/ghvstcode/agentfund/worker/internal/gitx"
	"github.com/ghvstcode/agentfund/worker/internal/lockfile"
	"github.com/ghvstcode/agentfund/worker/internal/minisign"
	"github.com/ghvstcode/agentfund/worker/internal/testutil"
)

const task = "0001-slugify"

var ctx = context.Background()

type fixture struct {
	repo   *testutil.Repo
	key    minisign.PrivateKey
	commit string
	hash   string
	lock   string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	key := testutil.Key(t)
	repo, commit := testutil.HelloRepo(t, key)
	return &fixture{
		repo: repo, key: key, commit: commit,
		hash: lockfile.SHA256Hex(repo.Read("tasks/" + task + ".yaml")),
		lock: lockfile.SHA256Hex(repo.Read(lockfile.Path)),
	}
}

func (f *fixture) request() Request {
	return Request{
		RepoDir: f.repo.Dir, Commit: f.commit, TaskID: task, ContentHash: f.hash,
		Approval: Approval{Pubkey: f.key.Public().String(), ApprovedCommit: f.commit, ApprovedLockSHA256: f.lock},
	}
}

func flip(b []byte, i int) []byte {
	out := append([]byte{}, b...)
	out[i] ^= 0x01
	return out
}

func wantStep(t *testing.T, err error, step Step, contains string) {
	t.Helper()
	var ve *Error
	if !errors.As(err, &ve) {
		t.Fatalf("want verification error at step %d, got %v", step, err)
	}
	if ve.Step != step {
		t.Fatalf("want step %d (%s), got step %d: %v", step, step, ve.Step, err)
	}
	if contains != "" && !strings.Contains(err.Error(), contains) {
		t.Fatalf("error %q does not mention %q", err, contains)
	}
}

func TestGoodSignature(t *testing.T) {
	f := newFixture(t)
	res, err := Task(ctx, f.request())
	if err != nil {
		t.Fatal(err)
	}
	if res.Manifest.ID != task || res.Basis != BasisApproved || res.Signer != f.key.Public() || res.Rotations != 0 ||
		res.LockSHA256 != f.lock || res.ManifestPath != "tasks/"+task+".yaml" || !bytes.Contains(res.ManifestRaw, []byte("slugify")) {
		t.Fatalf("unexpected result: %+v", res)
	}
}

// TestTampering covers every way the signed task set can disagree with the repo.
func TestTampering(t *testing.T) {
	type tc struct {
		name     string
		mutate   func(t *testing.T, f *fixture, req *Request) // changes worktree and/or request; a commit follows
		step     Step
		contains string
	}
	manifestPath := "tasks/" + task + ".yaml"
	cases := []tc{
		{"bad signature (over other bytes)", func(t *testing.T, f *fixture, _ *Request) {
			sig, _ := minisign.Sign(f.key, []byte("something else"), "x", "y")
			f.repo.Write(lockfile.SigPath, sig)
		}, StepSignature, "verification failed"},
		{"signature by wrong key", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Sign(testutil.Key(t))
		}, StepSignature, "different key"},
		{"wrong key reusing the pinned key id", func(t *testing.T, f *fixture, _ *Request) {
			other := testutil.Key(t)
			raw := f.repo.Read(lockfile.Path)
			sig, _ := minisign.Sign(other, raw, "x", "y")
			lines := strings.Split(string(sig), "\n")
			// Re-label the signature with the pinned key's id.
			pinnedSig, _ := minisign.Sign(f.key, raw, "x", "y")
			pl := strings.Split(string(pinnedSig), "\n")
			lines[1] = pl[1][:13] + lines[1][13:]
			f.repo.Write(lockfile.SigPath, []byte(strings.Join(lines, "\n")))
		}, StepSignature, ""},
		{"tampered manifest byte", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write(manifestPath, flip(f.repo.Read(manifestPath), 40))
		}, StepContent, "hashes to"},
		{"tampered other manifest byte", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write("tasks/0003-cli.yaml", flip(f.repo.Read("tasks/0003-cli.yaml"), 40))
		}, StepContent, "0003-cli"},
		{"manifest prompt appended", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write(manifestPath, append(f.repo.Read(manifestPath), '\n'))
		}, StepContent, "hashes to"},
		{"tampered lock byte", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write(lockfile.Path, flip(f.repo.Read(lockfile.Path), 60))
		}, StepSignature, ""},
		{"lock whitespace re-serialised", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write(lockfile.Path, bytes.ReplaceAll(f.repo.Read(lockfile.Path), []byte("  "), []byte("\t")))
		}, StepSignature, ""},
		{"tampered signature byte", func(t *testing.T, f *fixture, _ *Request) {
			sig := f.repo.Read(lockfile.SigPath)
			i := bytes.IndexByte(sig, '\n') + 20
			f.repo.Write(lockfile.SigPath, flip(sig, i))
		}, StepSignature, ""},
		{"tampered trusted comment", func(t *testing.T, f *fixture, _ *Request) {
			sig := f.repo.Read(lockfile.SigPath)
			f.repo.Write(lockfile.SigPath, bytes.Replace(sig, []byte("lock v1"), []byte("lock v2"), 1))
		}, StepSignature, "trusted comment"},
		{"tampered global signature", func(t *testing.T, f *fixture, _ *Request) {
			sig := f.repo.Read(lockfile.SigPath)
			f.repo.Write(lockfile.SigPath, flip(sig, len(sig)-10))
		}, StepSignature, ""},
		{"legacy Ed signature", func(t *testing.T, f *fixture, req *Request) {
			_, up, _ := upstream.GenerateKey(nil)
			text, _ := up.MarshalText()
			k, err := minisign.ParsePrivateKey(text, "")
			if err != nil {
				t.Fatal(err)
			}
			req.Approval.Pubkey = k.Public().String()
			f.repo.Write(lockfile.SigPath, upstream.SignWithComments(up, f.repo.Read(lockfile.Path), "t", "u"))
		}, StepSignature, "legacy"},
		{"signature missing", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Remove(lockfile.SigPath)
		}, StepSignature, "missing"},
		{"lock missing", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Remove(lockfile.Path)
		}, StepSignature, "missing"},
		{"manifest present but not in lock (lock stale)", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write("tasks/0004-extra.yaml", bytes.ReplaceAll(f.repo.Read(manifestPath), []byte(task), []byte("0004-extra")))
		}, StepContent, "not listed"},
		{"manifest present but not in lock (validly signed lock omits it)", func(t *testing.T, f *fixture, _ *Request) {
			l, _ := lockfile.Build(f.repo.Manifests(), nil)
			f.repo.Write("tasks/0004-extra.yaml", bytes.ReplaceAll(f.repo.Read(manifestPath), []byte(task), []byte("0004-extra")))
			f.repo.SignLock(l, f.key)
		}, StepContent, "not listed"},
		{"badly named manifest can never be listed", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write("tasks/sneaky.yaml", f.repo.Read(manifestPath))
		}, StepContent, "not listed"},
		{"lock entry with no file", func(t *testing.T, f *fixture, _ *Request) {
			l, _ := lockfile.Build(f.repo.Manifests(), nil)
			f.repo.Remove("tasks/0003-cli.yaml")
			f.repo.SignLock(l, f.key)
		}, StepContent, "does not exist"},
		{"claimed task removed from signed lock", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Remove(manifestPath)
			m := f.repo.Manifests()
			l := &lockfile.Lock{LockVersion: 1, SpecVersion: 1}
			for p, raw := range m {
				l.Manifests = append(l.Manifests, lockfile.Entry{Path: p, ID: strings.TrimSuffix(strings.TrimPrefix(p, "tasks/"), ".yaml"), SHA256: lockfile.SHA256Hex(raw)})
			}
			f.repo.SignLock(l, f.key)
		}, StepContent, "not listed in the lock"},
		{"hash mismatch vs claim content_hash", func(t *testing.T, f *fixture, req *Request) {
			req.ContentHash = strings.Repeat("0", 64)
		}, StepContent, "content hash"},
		{"claim content_hash empty", func(t *testing.T, f *fixture, req *Request) {
			req.ContentHash = ""
		}, StepContent, "content hash"},
		{"manifest changed and validly re-signed but claim names old hash", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Write(manifestPath, bytes.Replace(f.repo.Read(manifestPath), []byte("lowercase"), []byte("uppercase"), 1))
			f.repo.Sign(f.key)
		}, StepContent, "content hash"},
		{"unknown lock spec_version", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.SignRaw(bytes.Replace(f.repo.Read(lockfile.Path), []byte(`"spec_version": 1`), []byte(`"spec_version": 2`), 1), f.key)
		}, StepContent, "lock is invalid"},
		{"unknown lock_version", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.SignRaw(bytes.Replace(f.repo.Read(lockfile.Path), []byte(`"lock_version": 1`), []byte(`"lock_version": 9`), 1), f.key)
		}, StepContent, "lock is invalid"},
		{"unknown manifest spec_version", func(t *testing.T, f *fixture, req *Request) {
			raw := bytes.Replace(f.repo.Read(manifestPath), []byte("spec_version: 1"), []byte("spec_version: 2"), 1)
			f.repo.Write(manifestPath, raw)
			signLoose(f)
			req.ContentHash = lockfile.SHA256Hex(raw)
		}, StepContent, "spec_version"},
		{"manifest with YAML anchors", func(t *testing.T, f *fixture, req *Request) {
			raw := bytes.Replace(f.repo.Read(manifestPath), []byte("title: "), []byte("title: &a "), 1)
			f.repo.Write(manifestPath, raw)
			signLoose(f)
			req.ContentHash = lockfile.SHA256Hex(raw)
		}, StepContent, "anchors"},
		{"manifest id differs from file name", func(t *testing.T, f *fixture, req *Request) {
			raw := bytes.Replace(f.repo.Read(manifestPath), []byte("id: "+task), []byte("id: 0009-other"), 1)
			f.repo.Write(manifestPath, raw)
			signLoose(f)
			req.ContentHash = lockfile.SHA256Hex(raw)
		}, StepContent, "does not match file name"},
		{"lock entry id differs from path", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.SignRaw(bytes.Replace(f.repo.Read(lockfile.Path), []byte(`"id": "0001-slugify"`), []byte(`"id": "0009-other"`), 1), f.key)
		}, StepContent, "does not match its path"},
		{"lock with unknown property", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.SignRaw(bytes.Replace(f.repo.Read(lockfile.Path), []byte(`"lock_version": 1,`), []byte(`"lock_version": 1, "x": 1,`), 1), f.key)
		}, StepContent, "lock is invalid"},
		{"lock not JSON", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.SignRaw([]byte("lock_version: 1\n"), f.key)
		}, StepSignature, "JSON"},
		{"manifest is a symlink", func(t *testing.T, f *fixture, _ *Request) {
			f.repo.Remove(manifestPath)
			f.repo.Git("update-index", "--add", "--cacheinfo", "120000,"+f.repo.Git("hash-object", "-w", "tasks/0002-truncate.yaml")+","+manifestPath)
			f.repo.Git("commit", "-q", "-m", "symlink")
		}, StepContent, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			req := f.request()
			c.mutate(t, f, &req)
			if f.repo.Git("status", "--porcelain") != "" {
				req.Commit = f.repo.Commit("tamper")
			} else {
				req.Commit = f.repo.Git("rev-parse", "HEAD")
			}
			req.Approval.ApprovedCommit = req.Commit // isolate steps 2–3 from approval
			res, err := Task(ctx, req)
			if err == nil {
				t.Fatalf("tampered repo verified: %+v", res.Manifest)
			}
			wantStep(t, err, c.step, c.contains)
		})
	}
}

// signLoose signs a lock built from raw hashes without validating manifests.
func signLoose(f *fixture) {
	l := &lockfile.Lock{LockVersion: 1, SpecVersion: 1}
	for p, raw := range f.repo.Manifests() {
		l.Manifests = append(l.Manifests, lockfile.Entry{Path: p, ID: strings.TrimSuffix(strings.TrimPrefix(p, "tasks/"), ".yaml"), SHA256: lockfile.SHA256Hex(raw)})
	}
	f.repo.SignLock(l, f.key)
}

func TestCommitResolution(t *testing.T) {
	f := newFixture(t)
	for name, commit := range map[string]string{
		"nonexistent": strings.Repeat("a", 40),
		"abbreviated": f.commit[:12],
		"branch name": "main",
		"HEAD":        "HEAD",
		"empty":       "",
		"uppercase":   strings.ToUpper(f.commit),
		"option":      "--help",
		"tree id":     f.repo.Git("rev-parse", "HEAD^{tree}"),
		"blob id":     f.repo.Git("rev-parse", "HEAD:agentfund.yaml"),
	} {
		t.Run(name, func(t *testing.T) {
			req := f.request()
			req.Commit = commit
			_, err := Task(ctx, req)
			wantStep(t, err, StepFetch, "")
		})
	}
}

func TestApproval(t *testing.T) {
	// History: c0 (unsigned ancestor is irrelevant) — c1 signed — c2 code only — c3 new signed task set.
	// Side branch: orphan commit with a validly signed lock.
	f := newFixture(t)
	c1 := f.commit
	f.repo.Write("src/textutil.py", []byte("# code moved\n"))
	c2 := f.repo.Commit("code only")
	raw := bytes.Replace(f.repo.Read("tasks/"+task+".yaml"), []byte("lowercase"), []byte("UPPERCASE"), 1)
	f.repo.Write("tasks/"+task+".yaml", raw)
	f.repo.Sign(f.key)
	c3 := f.repo.Commit("new task text")
	hash3 := lockfile.SHA256Hex(raw)
	f.repo.Write("src/more.py", []byte("# more\n"))
	c4 := f.repo.Commit("code after c3")

	f.repo.Git("checkout", "-q", "--orphan", "side")
	f.repo.Sign(f.key)
	orphan := f.repo.Commit("unrelated history")
	f.repo.Git("checkout", "-q", "main")

	// A commit whose lock is signed by someone else, on top of c2.
	f.repo.Git("checkout", "-q", "-b", "evil", c2)
	f.repo.Sign(testutil.Key(t))
	evil := f.repo.Commit("re-signed by attacker")
	f.repo.Git("checkout", "-q", "main")

	pub := f.key.Public().String()
	cases := []struct {
		name     string
		commit   string
		hash     string
		approved string
		lockHash string
		policy   Policy
		ok       bool
		basis    Basis
		step     Step
	}{
		{"commit == approved", c2, f.hash, c2, f.lock, Policy{}, true, BasisApproved, 0},
		{"commit is ancestor of approved", c1, f.hash, c2, f.lock, Policy{}, true, BasisAncestor, 0},
		{"commit is distant ancestor of approved", c1, f.hash, c4, "x", Policy{}, true, BasisAncestor, 0},
		{"newer than approved, default policy", c2, f.hash, c1, f.lock, Policy{}, false, "", StepApproval},
		{"newer, follow_unchanged_lock, lock identical", c2, f.hash, c1, f.lock, Policy{FollowUnchangedLock: true}, true, BasisUnchangedLock, 0},
		{"newer, follow_unchanged_lock, lock changed", c3, hash3, c1, f.lock, Policy{FollowUnchangedLock: true}, false, "", StepApproval},
		{"newer, follow_unchanged_lock, approval has no lock hash", c2, f.hash, c1, "", Policy{FollowUnchangedLock: true}, false, "", StepApproval},
		{"newer, auto_follow, validly signed", c3, hash3, c1, f.lock, Policy{AutoFollowSignedUpdates: true}, true, BasisAutoFollow, 0},
		{"newer, both policies, lock changed", c4, hash3, c1, f.lock, Policy{FollowUnchangedLock: true, AutoFollowSignedUpdates: true}, true, BasisAutoFollow, 0},
		{"newer, auto_follow, signed by another key", evil, f.hash, c1, f.lock, Policy{AutoFollowSignedUpdates: true}, false, "", StepSignature},
		{"newer, follow_unchanged_lock, signed by another key", evil, f.hash, c1, f.lock, Policy{FollowUnchangedLock: true}, false, "", StepSignature},
		{"unrelated history, default policy", orphan, hash3, c2, f.lock, Policy{}, false, "", StepApproval},
		{"unrelated history, auto_follow", orphan, hash3, c2, f.lock, Policy{AutoFollowSignedUpdates: true}, true, BasisAutoFollow, 0},
		{"approved commit unknown to the repo", c2, f.hash, strings.Repeat("b", 40), f.lock, Policy{}, false, "", StepApproval},
		{"approval record empty", c2, f.hash, "", "", Policy{AutoFollowSignedUpdates: true}, false, "", StepApproval},
		{"nonexistent commit even with auto_follow", strings.Repeat("c", 40), f.hash, c1, f.lock, Policy{AutoFollowSignedUpdates: true}, false, "", StepFetch},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res, err := Task(ctx, Request{
				RepoDir: f.repo.Dir, Commit: c.commit, TaskID: task, ContentHash: c.hash,
				Approval: Approval{Pubkey: pub, ApprovedCommit: c.approved, ApprovedLockSHA256: c.lockHash},
				Policy:   c.policy,
			})
			if c.ok {
				if err != nil {
					t.Fatalf("rejected: %v", err)
				}
				if res.Basis != c.basis {
					t.Fatalf("basis %q, want %q", res.Basis, c.basis)
				}
				return
			}
			if err == nil {
				t.Fatalf("accepted with basis %q", res.Basis)
			}
			wantStep(t, err, c.step, "")
		})
	}
}

func rotation(t *testing.T, from minisign.PrivateKey, to minisign.PublicKey) lockfile.Rotation {
	t.Helper()
	r, err := lockfile.NewRotation(from, to)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestKeyRotation(t *testing.T) {
	k0, k1, k2, stranger := testutil.Key(t), testutil.Key(t), testutil.Key(t), testutil.Key(t)
	r01 := rotation(t, k0, k1.Public())
	r12 := rotation(t, k1, k2.Public())

	chain := func(n int) (keys []minisign.PrivateKey, links []lockfile.Rotation) {
		keys = []minisign.PrivateKey{testutil.Key(t)}
		for i := 0; i < n; i++ {
			next := testutil.Key(t)
			links = append(links, rotation(t, keys[i], next.Public()))
			keys = append(keys, next)
		}
		return
	}
	k16, l16 := chain(16)
	k17, l17 := chain(17)

	broken := r01
	broken.Signature = strings.Replace(r01.Signature, "rotation v1", "rotation v2", 1)
	forged := rotation(t, stranger, k1.Public()) // signed by a stranger...
	forged.From = k0.Public().String()           // ...but claiming to be from k0
	redirected := r01
	redirected.To = stranger.Public().String() // valid signature, different target

	cases := []struct {
		name      string
		pinned    minisign.PrivateKey
		signer    minisign.PrivateKey
		rotations []lockfile.Rotation
		descKey   *minisign.PrivateKey // key written to agentfund.yaml (default: signer)
		ok        bool
		links     int
	}{
		{"no rotation", k0, k0, nil, nil, true, 0},
		{"chain of 1", k0, k1, []lockfile.Rotation{r01}, nil, true, 1},
		{"chain of 2", k0, k2, []lockfile.Rotation{r01, r12}, nil, true, 2},
		{"donor pinned the middle key", k1, k2, []lockfile.Rotation{r01, r12}, nil, true, 1},
		{"donor pinned the newest key, old links ignored", k2, k2, []lockfile.Rotation{r01, r12}, nil, true, 0},
		{"rotation announced, lock still signed by old key", k0, k0, []lockfile.Rotation{r01}, nil, true, 0},
		{"key in agentfund.yaml alone is never accepted", k0, k1, nil, nil, false, 0},
		{"broken link (signature edited)", k0, k1, []lockfile.Rotation{broken}, nil, false, 0},
		{"broken first link of two", k0, k2, []lockfile.Rotation{broken, r12}, nil, false, 0},
		{"forged link (signed by stranger, labelled as pinned)", k0, k1, []lockfile.Rotation{forged}, nil, false, 0},
		{"link target swapped", k0, stranger, []lockfile.Rotation{redirected}, nil, false, 0},
		{"chain does not start at pinned key", k0, k2, []lockfile.Rotation{r12}, nil, false, 0},
		{"links out of order", k0, k2, []lockfile.Rotation{r12, r01}, nil, false, 0},
		{"signed by a key outside the chain", k0, stranger, []lockfile.Rotation{r01, r12}, nil, false, 0},
		{"rotated away: pinned newest, lock signed by old", k2, k0, []lockfile.Rotation{r01, r12}, nil, false, 0},
		{"16 links accepted", k16[0], k16[16], l16, nil, true, 16},
		{"17 links rejected", k17[0], k17[17], l17, nil, false, 0},
		{"17 entries rejected even when signed by pinned key", k17[0], k17[0], l17, nil, false, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			repo := testutil.NewRepo(t)
			desc := c.signer
			if c.descKey != nil {
				desc = *c.descKey
			}
			repo.CopyHello(desc.Public())
			l, err := lockfile.Build(repo.Manifests(), nil)
			if err != nil {
				t.Fatal(err)
			}
			l.Rotations = c.rotations
			repo.SignLock(l, c.signer)
			commit := repo.Commit("signed")
			res, err := Task(ctx, Request{
				RepoDir: repo.Dir, Commit: commit, TaskID: task,
				ContentHash: lockfile.SHA256Hex(repo.Read("tasks/" + task + ".yaml")),
				Approval:    Approval{Pubkey: c.pinned.Public().String(), ApprovedCommit: commit},
			})
			if c.ok {
				if err != nil {
					t.Fatalf("rejected: %v", err)
				}
				if res.Signer != c.signer.Public() || res.Rotations != c.links {
					t.Fatalf("signer/links = %s/%d, want %s/%d", res.Signer.KeyIDHex(), res.Rotations, c.signer.Public().KeyIDHex(), c.links)
				}
				return
			}
			if err == nil {
				t.Fatal("accepted")
			}
			var ve *Error
			if !errors.As(err, &ve) || (ve.Step != StepSignature && ve.Step != StepContent) {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestLegacyRotationLinkRejected(t *testing.T) {
	_, up0, _ := upstream.GenerateKey(nil)
	text, _ := up0.MarshalText()
	k0, _ := minisign.ParsePrivateKey(text, "")
	k1 := testutil.Key(t)
	from, to := k0.Public().String(), k1.Public().String()
	legacy := upstream.SignWithComments(up0, lockfile.RotationMessage(from, to), "t", "u")
	repo := testutil.NewRepo(t)
	repo.CopyHello(k1.Public())
	l, _ := lockfile.Build(repo.Manifests(), nil)
	l.Rotations = []lockfile.Rotation{{From: from, To: to, Signature: string(legacy)}}
	repo.SignLock(l, k1)
	commit := repo.Commit("signed")
	_, err := Lock(ctx, repo.Dir, commit, from)
	wantStep(t, err, StepSignature, "")
}

// memSource serves the tasks/ directory from memory so every byte can be
// flipped without paying for a git commit each time.
type memSource map[string][]byte

func (m memSource) list(context.Context) ([]gitx.TreeEntry, error) {
	var out []gitx.TreeEntry
	for p := range m {
		out = append(out, gitx.TreeEntry{Mode: "100644", Type: "blob", OID: p, Path: p})
	}
	return out, nil
}
func (m memSource) read(_ context.Context, oid string) ([]byte, error) { return m[oid], nil }

func verifyMem(src memSource, pinned, hash string) error {
	lr, err := lockFrom(ctx, src, strings.Repeat("1", 40), pinned)
	if err != nil {
		return err
	}
	_, err = taskFrom(ctx, lr, task, hash)
	return err
}

// TestEveryFlippedByteFails flips every byte of the lock, the signature and
// the claimed manifest in turn: a tampered byte anywhere must fail loudly.
// The only tolerated bytes are those of the signature's *untrusted* comment,
// which minisign by design does not authenticate.
func TestEveryFlippedByteFails(t *testing.T) {
	f := newFixture(t)
	base := memSource{}
	for p, raw := range f.repo.Manifests() {
		base[p] = raw
	}
	base[lockfile.Path] = f.repo.Read(lockfile.Path)
	base[lockfile.SigPath] = f.repo.Read(lockfile.SigPath)
	pinned := f.key.Public().String()
	if err := verifyMem(base, pinned, f.hash); err != nil {
		t.Fatalf("baseline: %v", err)
	}

	sig := base[lockfile.SigPath]
	untrustedStart := len("untrusted comment: ")
	untrustedEnd := bytes.IndexByte(sig, '\n')

	total, tolerated := 0, 0
	for _, target := range []string{lockfile.Path, lockfile.SigPath, "tasks/" + task + ".yaml", "tasks/0002-truncate.yaml"} {
		orig := base[target]
		for i := range orig {
			for _, mask := range []byte{0x01, 0x20, 0x80} {
				mut := append([]byte{}, orig...)
				mut[i] ^= mask
				src := memSource{}
				for k, v := range base {
					src[k] = v
				}
				src[target] = mut
				total++
				err := verifyMem(src, pinned, f.hash)
				if err == nil {
					if target == lockfile.SigPath && i >= untrustedStart && i < untrustedEnd && mut[i] != '\n' && mut[i] != '\r' {
						tolerated++
						continue
					}
					t.Fatalf("%s: flipping byte %d (^%#x, %q -> %q) still verifies", target, i, mask, orig[i], mut[i])
				}
				if !IsVerificationError(err) {
					t.Fatalf("%s byte %d: non-verification error %v", target, i, err)
				}
			}
		}
	}
	if total < 3000 || tolerated > 3*(untrustedEnd-untrustedStart) {
		t.Fatalf("suspicious coverage: %d mutations, %d tolerated", total, tolerated)
	}

	// The same property through the real git-backed path, on a stride.
	for _, target := range []string{lockfile.Path, lockfile.SigPath, "tasks/" + task + ".yaml"} {
		orig := f.repo.Read(target)
		for i := 0; i < len(orig); i += 53 {
			if target == lockfile.SigPath && i >= untrustedStart && i < untrustedEnd {
				continue
			}
			f.repo.Write(target, flip(orig, i))
			commit := f.repo.Commit(fmt.Sprintf("flip %s %d", target, i))
			req := f.request()
			req.Commit, req.Approval.ApprovedCommit = commit, commit
			if _, err := Task(ctx, req); err == nil {
				t.Fatalf("git path: %s byte %d flipped still verifies", target, i)
			}
		}
		f.repo.Write(target, orig)
	}
}
