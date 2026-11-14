package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/api"
	"github.com/agentfund/agentfund/worker/internal/apitest"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/lockfile"
	"github.com/agentfund/agentfund/worker/internal/minisign"
	"github.com/agentfund/agentfund/worker/internal/pipeline"
	"github.com/agentfund/agentfund/worker/internal/testenv"
	"github.com/agentfund/agentfund/worker/internal/testutil"
	"github.com/agentfund/agentfund/worker/internal/verify"
)

// run executes the CLI in-process.
func run(t *testing.T, stdin string, args ...string) (code int, stdout, stderr string) {
	t.Helper()
	var out, errb bytes.Buffer
	code = Main(args, strings.NewReader(stdin), &out, &errb)
	return code, out.String(), errb.String()
}

func mustRun(t *testing.T, stdin string, args ...string) string {
	t.Helper()
	code, out, errOut := run(t, stdin, args...)
	if code != 0 {
		t.Fatalf("agentfund %s: exit %d\nstdout: %s\nstderr: %s", strings.Join(args, " "), code, out, errOut)
	}
	return out + errOut
}

// isolate points every state directory at temp dirs.
func isolate(t *testing.T) (cfgDir, dataDir string) {
	t.Helper()
	cfgDir, dataDir = t.TempDir(), t.TempDir()
	t.Setenv(config.EnvConfigDir, cfgDir)
	t.Setenv(config.EnvDataDir, dataDir)
	t.Setenv(config.EnvAPIKey, "")
	t.Setenv(config.EnvKeyPass, "")
	t.Setenv(config.EnvKey, "")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv(EnvSandboxImage, "")
	t.Setenv(EnvProxyImage, "")
	return
}

// useStubDocker rewrites the config so the "docker" binary is a shell stub in a
// temp dir. It answers `version`, `image inspect` and the label listings the
// worker makes at start-up, and fails (logging UNEXPECTED) for anything that
// would create, run or remove something. It returns the stub's call log.
func useStubDocker(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	logPath := filepath.Join(dir, "calls.log")
	stub := filepath.Join(dir, "docker-stub")
	script := "#!/bin/sh\n" +
		"case \"$1 $2\" in\n" +
		"  'version '*) echo \"$*\" >>'" + logPath + "'; echo 0.0-stub ;;\n" +
		"  'image inspect') echo \"$*\" >>'" + logPath + "'; echo sha256:stub ;;\n" +
		"  'ps -a'|'volume ls'|'network ls') echo \"$*\" >>'" + logPath + "' ;;\n" +
		"  *) echo \"UNEXPECTED $*\" >>'" + logPath + "'; exit 1 ;;\n" +
		"esac\n"
	if err := os.WriteFile(stub, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	cfg.Global.Sandbox.Docker = stub
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
	return logPath
}

func allowFileRepos(t *testing.T) {
	t.Helper()
	cfg := config.Default()
	cfg.Global.AllowedGitHosts = []string{"github.com", "file"}
	if err := cfg.Save(); err != nil {
		t.Fatal(err)
	}
}

func copyHello(t *testing.T) string {
	t.Helper()
	repo := testutil.NewRepo(t)
	repo.CopyHello(testutil.Key(t).Public())
	return repo.Dir
}

func TestMaintainerFlowKeygenValidateSignRotate(t *testing.T) {
	isolate(t)
	proj := copyHello(t)
	tasks := filepath.Join(proj, "tasks")
	keys := t.TempDir()

	out := mustRun(t, "", "keygen", "--name", "k0", "--out", keys, "--no-password")
	if !strings.Contains(out, "fingerprint: SHA256:") || !strings.Contains(out, "NOT password-protected") {
		t.Fatalf("keygen output:\n%s", out)
	}
	if st, err := os.Stat(filepath.Join(keys, "k0.key")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("secret key file: %v %v", st, err)
	}
	if code, _, errOut := run(t, "", "keygen", "--name", "k0", "--out", keys, "--no-password"); code == 0 || !strings.Contains(errOut, "refusing to overwrite") {
		t.Fatalf("keygen overwrote an existing key: %d %s", code, errOut)
	}
	pubFile, _ := os.ReadFile(filepath.Join(keys, "k0.pub"))
	lines := strings.Split(strings.TrimSpace(string(pubFile)), "\n")
	k0, err := minisign.ParsePublicKey(lines[len(lines)-1])
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, k0.String()) || !strings.Contains(out, k0.Fingerprint()) {
		t.Fatal("keygen did not print the key it wrote")
	}

	if out := mustRun(t, "", "validate", tasks); !strings.Contains(out, "3 manifest(s), 0 error(s), 0 warning(s)") {
		t.Fatalf("validate:\n%s", out)
	}
	out = mustRun(t, "", "sign", tasks, "--key", filepath.Join(keys, "k0.key"))
	if !strings.Contains(out, "signed 3 manifest(s)") || !strings.Contains(out, "warning:") || !strings.Contains(out, "pubkey: "+k0.String()) {
		t.Fatalf("sign should warn that agentfund.yaml publishes another key:\n%s", out)
	}
	lockRaw, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock"))
	if !bytes.HasSuffix(lockRaw, []byte("}\n")) || !bytes.Contains(lockRaw, []byte("\n  \"manifests\": [\n    {\n      \"path\": \"tasks/0001-slugify.yaml\"")) {
		t.Fatalf("lock is not 2-space JSON with a trailing newline:\n%s", lockRaw)
	}
	sig, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock.minisig"))
	if err := minisign.Verify(k0, lockRaw, sig); err != nil {
		t.Fatalf("signature written by `sign` does not verify: %v", err)
	}
	if !bytes.Contains(sig, []byte("trusted comment: agentfund lock v1 key:"+k0.KeyIDHex())) {
		t.Fatalf("trusted comment:\n%s", sig)
	}
	// Signing is deterministic for unchanged input.
	mustRun(t, "", "sign", tasks, "--key", filepath.Join(keys, "k0.key"))
	if again, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock")); !bytes.Equal(again, lockRaw) {
		t.Fatal("re-signing changed the lock bytes")
	}

	// Rotate k0 -> k1 -> k2; a donor who pinned k0 still verifies.
	mustRun(t, "", "keygen", "--name", "k1", "--out", keys, "--no-password")
	mustRun(t, "", "keygen", "--name", "k2", "--out", keys, "--no-password")
	out = mustRun(t, "", "sign", tasks, "--key", filepath.Join(keys, "k1.key"), "--rotate-from", filepath.Join(keys, "k0.key"))
	if !strings.Contains(out, "rotation: "+k0.Fingerprint()) {
		t.Fatalf("rotate output:\n%s", out)
	}
	mustRun(t, "", "sign", tasks, "--key", filepath.Join(keys, "k2.key"), "--rotate-from", filepath.Join(keys, "k1.key"))
	mustRun(t, "", "sign", tasks, "--key", filepath.Join(keys, "k2.key")) // plain re-sign keeps the chain
	lockRaw, _ = os.ReadFile(filepath.Join(tasks, "MANIFEST.lock"))
	lock, err := lockfile.Parse(lockRaw)
	if err != nil || len(lock.Rotations) != 2 {
		t.Fatalf("rotations after two rotations and a re-sign: %+v %v", lock, err)
	}
	repo := &testutil.Repo{T: t, Dir: proj}
	commit := repo.Commit("signed with rotations")
	lr, err := verify.Lock(context.Background(), proj, commit, k0.String())
	if err != nil || lr.Rotations != 2 {
		t.Fatalf("verify from the original key: %+v %v", lr, err)
	}
	if code, _, errOut := run(t, "", "sign", tasks, "--key", filepath.Join(keys, "k2.key"), "--rotate-from", filepath.Join(keys, "k2.key")); code == 0 {
		t.Fatalf("rotating a key to itself was accepted: %s", errOut)
	}

	// sign refuses invalid manifests; validate reports them.
	bad := filepath.Join(tasks, "0001-slugify.yaml")
	orig, _ := os.ReadFile(bad)
	os.WriteFile(bad, bytes.Replace(orig, []byte("max_tokens: 1000000"), []byte("max_tokens: 1"), 1), 0o644)
	if code, out, _ := run(t, "", "validate", tasks); code != ExitError || !strings.Contains(out, "error") {
		t.Fatalf("validate on a bad manifest: %d\n%s", code, out)
	}
	before, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock"))
	if code, _, errOut := run(t, "", "sign", tasks, "--key", filepath.Join(keys, "k2.key")); code == 0 || !strings.Contains(errOut, "refusing to sign") {
		t.Fatalf("sign accepted a bad manifest: %s", errOut)
	}
	if after, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock")); !bytes.Equal(before, after) {
		t.Fatal("a refused sign modified the lock")
	}
	// --strict turns warnings into failures.
	os.WriteFile(bad, bytes.Replace(orig, []byte("timeout_minutes: 20\n"), nil, 1), 0o644)
	if code, _, _ := run(t, "", "validate", tasks); code != 0 {
		t.Fatal("a warning alone must not fail validate")
	}
	if code, out, _ := run(t, "", "validate", "--strict", tasks); code != ExitError || !strings.Contains(out, "timeout_minutes is not set") {
		t.Fatalf("validate --strict: %d\n%s", code, out)
	}
}

// Signing with a password-protected key, at a small scrypt cost (the cost is
// read from the key file), so this always runs — also under -race.
func TestSignWithEncryptedKey(t *testing.T) {
	isolate(t)
	proj := copyHello(t)
	key := testutil.Key(t)
	enc, err := key.MarshalKDF("correct horse battery staple", minisign.KDFInteractive)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "enc.key")
	if err := os.WriteFile(keyPath, enc, 0o600); err != nil {
		t.Fatal(err)
	}
	tasks := filepath.Join(proj, "tasks")
	t.Setenv(config.EnvKeyPass, "correct horse battery staple")
	t.Setenv(config.EnvKey, keyPath) // default key from the environment
	if out := mustRun(t, "", "sign", tasks); !strings.Contains(out, key.Public().Fingerprint()) {
		t.Fatalf("sign with an encrypted key:\n%s", out)
	}
	lockRaw, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock"))
	sig, _ := os.ReadFile(filepath.Join(tasks, "MANIFEST.lock.minisig"))
	if err := minisign.Verify(key.Public(), lockRaw, sig); err != nil {
		t.Fatal(err)
	}
	t.Setenv(config.EnvKeyPass, "wrong")
	if code, _, errOut := run(t, "", "sign", tasks, "--key", keyPath); code == 0 || !strings.Contains(errOut, "wrong password") {
		t.Fatalf("sign with a wrong password: %d %s", code, errOut)
	}
	// Without the variable the password is read from stdin (no terminal in tests).
	t.Setenv(config.EnvKeyPass, "")
	mustRun(t, "correct horse battery staple\n", "sign", tasks, "--key", keyPath)
	if code, _, _ := run(t, "nope\n", "sign", tasks, "--key", keyPath); code == 0 {
		t.Fatal("wrong password from stdin accepted")
	}
}

// keygen always writes the stock tool's scrypt cost (1 GiB); see testenv.SkipIfHeavyKDF.
func TestKeygenWithPassword(t *testing.T) {
	testenv.SkipIfHeavyKDF(t)
	isolate(t)
	proj := copyHello(t)
	t.Setenv(config.EnvKeyPass, "correct horse battery staple")
	out := mustRun(t, "", "keygen") // default name and location
	keyPath := filepath.Join(config.KeysDir(), "default.key")
	raw, err := os.ReadFile(keyPath)
	if err != nil || !minisign.IsEncrypted(raw) || strings.Contains(out, "NOT password-protected") {
		t.Fatalf("expected an encrypted key at %s: %v", keyPath, err)
	}
	mustRun(t, "", "sign", filepath.Join(proj, "tasks")) // finds the default key, password from env
	t.Setenv(config.EnvKeyPass, "wrong")
	if code, _, errOut := run(t, "", "sign", filepath.Join(proj, "tasks")); code == 0 || !strings.Contains(errOut, "wrong password") {
		t.Fatalf("sign with a wrong password: %d %s", code, errOut)
	}
}

func TestLogin(t *testing.T) {
	isolate(t)
	h := apitest.NewHello(t, nil)
	if code, _, errOut := run(t, "af_wrong_key\n", "login", h.Server.URL, "--key-stdin"); code == 0 || !strings.Contains(errOut, "did not accept") {
		t.Fatalf("login with a bad key: %d %s", code, errOut)
	}
	if _, err := os.Stat(config.CredentialsPath()); err == nil {
		t.Fatal("a rejected key was stored")
	}
	if code, _, _ := run(t, "not-a-key\n", "login", h.Server.URL, "--key-stdin"); code == 0 {
		t.Fatal("accepted a key without the af_ prefix")
	}
	out := mustRun(t, h.Server.APIKey+"\n", "login", h.Server.URL+"/", "--key-stdin")
	if !strings.Contains(out, "logged in to "+h.Server.URL+" as donor") || strings.Contains(out, h.Server.APIKey) {
		t.Fatalf("login output:\n%s", out)
	}
	st, err := os.Stat(config.CredentialsPath())
	if err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("credentials file: %v %v", st, err)
	}
	if k, err := config.APIKey(h.Server.URL, nil); err != nil || k != h.Server.APIKey {
		t.Fatalf("stored key: %q %v", k, err)
	}
}

func TestLoginVia(t *testing.T) {
	isolate(t)
	home, target := apitest.New(t), apitest.New(t)
	homeHost := strings.TrimPrefix(home.URL, "http://")

	// No credential for the home server yet.
	code, _, errOut := run(t, "", "login", target.URL, "--via", home.URL)
	if code == 0 || !strings.Contains(errOut, "run `agentfund login "+home.URL+"` first") {
		t.Fatalf("login --via without a home credential: %d %s", code, errOut)
	}
	if len(home.Calls("/v1/")) != 0 || len(target.Calls("/v1/")) != 0 {
		t.Fatal("servers were contacted before the home credential was found")
	}
	mustRun(t, home.APIKey+"\n", "login", home.URL, "--key-stdin")

	// Usage errors.
	for _, args := range [][]string{
		{"login", home.URL + "/", "--via", home.URL},
		{"login", target.URL, "--via", "not-a-url"},
		{"login", target.URL, "--via", home.URL, "--key-stdin"},
	} {
		if code, _, errOut := run(t, "", args...); code != ExitUsage || errOut == "" {
			t.Errorf("%v: exit %d, stderr %q", args, code, errOut)
		}
	}

	// The target has not peered with home.
	code, _, errOut = run(t, "", "login", target.URL, "--via", home.URL)
	if code == 0 || !strings.Contains(errOut, target.URL+" does not accept identities from "+home.URL) ||
		!strings.Contains(errOut, "turn on 'accept identities'") || !strings.Contains(errOut, "`agentfund login "+target.URL+"`") {
		t.Fatalf("login --via an untrusted peer: %d %s", code, errOut)
	}
	if _, err := config.APIKey(target.URL, nil); err == nil {
		t.Fatal("a key was stored after a refused federated login")
	}

	// Federation off on either side: refused before anything is minted.
	for _, off := range []*apitest.Server{home, target} {
		before := len(home.Calls("/v1/federation/assertions"))
		off.Lock()
		off.Federation = false
		off.Unlock()
		code, _, errOut = run(t, "", "login", target.URL, "--via", home.URL)
		if code == 0 || !strings.Contains(errOut, off.URL+" has federation turned off") {
			t.Fatalf("login --via with federation off on %s: %d %s", off.URL, code, errOut)
		}
		if len(home.Calls("/v1/federation/assertions")) != before || len(target.Calls("/v1/auth/federated")) != 1 {
			t.Fatal("an assertion was minted or presented although federation is off")
		}
		off.Lock()
		off.Federation = true
		off.Unlock()
	}

	// Happy path.
	target.Lock()
	target.AcceptIdentitiesFrom = []string{home.URL}
	target.Unlock()
	out := mustRun(t, "", "login", target.URL+"/", "--via", home.URL+"/")
	want := "logged in to " + target.URL + " as donor@" + homeHost + " (donor) via " + home.URL + "; key stored in " + config.CredentialsPath() + "\n"
	if out != want {
		t.Fatalf("login --via output:\n got %q\nwant %q", out, want)
	}
	key, err := config.APIKey(target.URL, nil)
	if err != nil || !strings.HasPrefix(key, "af_") || key == home.APIKey || strings.Contains(out, key) {
		t.Fatalf("stored federated key: %q %v", key, err)
	}
	if k, _ := config.APIKey(home.URL, nil); k != home.APIKey {
		t.Fatalf("the home credential changed: %q", k)
	}
	me, err := api.New(target.URL, key).Me(context.Background())
	if err != nil || me.Handle != "donor@"+homeHost || me.ID != home.URL+"/u/donor" {
		t.Fatalf("the stored key does not work on the target: %+v %v", me, err)
	}
	mint := home.Calls("/v1/federation/assertions")
	if last := mint[len(mint)-1]; last.Auth != "Bearer "+home.APIKey || last.Body["audience"] != target.URL {
		t.Fatalf("assertion request: %+v", last)
	}
	for _, c := range target.Calls("/v1/") {
		if c.Auth != "" && c.Path != "/v1/me" {
			t.Fatalf("%s %s on the target carried credentials (%q)", c.Method, c.Path, c.Auth)
		}
	}
	ex := target.Calls("/v1/auth/federated")
	if label, _ := ex[len(ex)-1].Body["label"].(string); !strings.HasPrefix(label, "agentfund worker") || len(label) > 80 {
		t.Fatalf("key label %q", label)
	}

	// A federated account cannot vouch for itself elsewhere.
	home.Lock()
	home.FederatedAccount = true
	home.Unlock()
	if code, _, errOut := run(t, "", "login", target.URL, "--via", home.URL); code == 0 || !strings.Contains(errOut, "is itself a federated one") {
		t.Fatalf("login --via a federated home account: %d %s", code, errOut)
	}
}

func TestApproveDryRunStatus(t *testing.T) {
	isolate(t)
	h := apitest.NewHello(t, nil)
	ref := h.Server.URL + "/" + h.Server.Slug

	// file:// is not an allowed git host by default.
	if code, _, errOut := run(t, "", "approve", ref, "--yes"); code == 0 || !strings.Contains(errOut, "allowed_git_hosts") {
		t.Fatalf("approve of a file:// repo with default config: %d %s", code, errOut)
	}
	allowFileRepos(t)

	// Declining changes nothing.
	if code, out, _ := run(t, "no\n", "approve", ref); code == 0 || !strings.Contains(out, "Pin this key and commit?") {
		t.Fatalf("declined approve: %d\n%s", code, out)
	}
	if cfg, _ := config.Load(); len(cfg.Projects) != 0 {
		t.Fatal("a declined approval was stored")
	}

	out := mustRun(t, "y\n", "approve", ref)
	// The two key lines (and their fingerprints) start in the same column.
	col := func(prefix string) int {
		for _, l := range strings.Split(out, "\n") {
			if strings.HasPrefix(l, "  "+prefix) {
				return strings.Index(l, "RW")
			}
		}
		return -1
	}
	if a, b := col("server publishes:"), col("repo agentfund.yaml:"); a < 0 || a != b {
		t.Fatalf("key lines are not aligned (columns %d and %d):\n%s", a, b, out)
	}
	if strings.Contains(out, "[yes/no]") || strings.Count(out, "[y/N]") != 2 {
		t.Fatalf("both prompts should use [y/N]:\n%s", out)
	}
	fp := h.Key.Public().Fingerprint()
	for _, want := range []string{
		"FINGERPRINT TO PIN:  " + fp, "Audit tab", "repo key == server key: MATCH", "signature OK", "3 manifest(s)",
		"TASK 0001-slugify", "TASK 0002-truncate", "TASK 0003-cli", "Implement `slugify(text: str) -> str` in src/textutil.py.",
		"- src/textutil.py", "python3 -m unittest discover -s tests -p \"test_slugify.py\"", "max_tokens:      1M", "timeout_minutes: 20",
		"depends_on:      0001-slugify, 0002-truncate", "scope.read: (unset", "approved " + ref,
	} {
		if !strings.Contains(out, want) {
			t.Errorf("approve output lacks %q", want)
		}
	}
	for _, want := range []string{`server trust tier:     "established"`, "per-task ceiling:      5M — your max_tokens_per_task binds",
		"per-day for project:   10M — your tokens_per_day (all projects) binds", "server max_tokens_per_task none", "can only tighten"} {
		if !strings.Contains(out, want) {
			t.Errorf("approve output lacks %q\n%s", want, out[strings.Index(out, "Trust and caps"):])
		}
	}
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	p := cfg.Projects[ref]
	if p == nil || p.Pubkey != h.Key.Public().String() || p.ApprovedCommit != h.Commit || p.ApprovedLockSHA256 != h.Server.LockSHA256 || p.ApprovedAt.IsZero() {
		t.Fatalf("approval record: %+v", p)
	}
	if p.FollowUnchangedLock == nil || *p.FollowUnchangedLock {
		t.Fatalf("no answer to the follow question must mean off: %+v", p.FollowUnchangedLock)
	}
	if !strings.Contains(out, "byte-identical to what you just reviewed? [y/N]") || !strings.Contains(out, "follow_unchanged_lock: off for this project") {
		t.Fatalf("approve did not ask about following:\n%s", out)
	}
	// Answering yes turns it on for this project only; flags do the same non-interactively.
	out = mustRun(t, "yes\ny\n", "approve", ref)
	if cfg, _ := config.Load(); cfg.Projects[ref].FollowUnchangedLock == nil || !*cfg.Projects[ref].FollowUnchangedLock || cfg.Global.FollowUnchangedLock ||
		!strings.Contains(out, "follow_unchanged_lock: ON for this project") || !strings.Contains(out, "runs only inside the sandbox") {
		t.Fatalf("follow answer yes not stored per project:\n%s", out)
	}
	mustRun(t, "", "approve", ref, "--yes") // --yes alone leaves the stored answer alone
	if cfg, _ := config.Load(); !*cfg.Projects[ref].FollowUnchangedLock {
		t.Fatal("--yes alone changed the follow setting")
	}
	mustRun(t, "", "approve", ref, "--yes", "--no-follow-unchanged-lock")
	if cfg, _ := config.Load(); *cfg.Projects[ref].FollowUnchangedLock {
		t.Fatal("--no-follow-unchanged-lock did not turn following off")
	}
	if help := mustRun(t, "", "approve", "--help"); strings.Contains(help, "--no-follow ") || !strings.Contains(help, "--no-follow-unchanged-lock") {
		t.Fatalf("approve --help should list only the new flag name:\n%s", help)
	}
	mustRun(t, "", "approve", ref, "--yes", "--follow-unchanged-lock")
	if cfg, _ := config.Load(); !*cfg.Projects[ref].FollowUnchangedLock {
		t.Fatal("--follow-unchanged-lock did not turn following on")
	}
	if code, _, _ := run(t, "", "approve", ref, "--yes", "--follow-unchanged-lock", "--no-follow-unchanged-lock"); code == 0 {
		t.Fatal("contradictory follow flags accepted")
	}
	mustRun(t, "", "approve", ref, "--yes", "--no-follow")
	rawCfg, _ := os.ReadFile(config.Path())
	if !strings.Contains(string(rawCfg), "# ") || !strings.Contains(string(rawCfg), "auto_follow_signed_updates: false") {
		t.Fatalf("config should be commented and conservative:\n%s", rawCfg)
	}

	// dry-run: full prompts, reasons, no claims.
	out = mustRun(t, "", "dry-run", h.Server.Slug, "-n", "3")
	for _, want := range []string{"1. 0001-slugify — WOULD RUN", "2. 0002-truncate — SKIPPED: not claimable", "Implement `truncate(text: str, width: int) -> str`", "1 of 3 task(s) would run", "No claims were made"} {
		if !strings.Contains(out, want) {
			t.Errorf("dry-run output lacks %q\n%s", want, out)
		}
	}
	if n := len(h.Server.Outcomes()); n != 0 {
		t.Fatalf("dry-run made %d claim(s)", n)
	}
	if code, _, _ := run(t, "", "dry-run", "no-such-project"); code == 0 {
		t.Fatal("dry-run of an unapproved project succeeded")
	}

	// status with nothing run yet (no API key: the server column reports that instead of failing).
	out = mustRun(t, "", "status")
	for _, want := range []string{"Tokens today:", "0 of 10M", "Running (0)", "Recent (0)", ref, "no API key"} {
		if !strings.Contains(out, want) {
			t.Errorf("status output lacks %q\n%s", want, out)
		}
	}
	var js map[string]any
	if err := json.Unmarshal([]byte(mustRun(t, "", "status", "--json")), &js); err != nil || js["tokens_per_day"] != float64(10_000_000) {
		t.Fatalf("status --json: %v %v", js, err)
	}
	if out := mustRun(t, "", "logs"); !strings.Contains(out, "no run logs") {
		t.Fatalf("logs: %s", out)
	}

	// work refuses to start without agent credentials, before claiming anything.
	t.Setenv(config.EnvAPIKey, h.Server.APIKey)
	code, _, errOut := run(t, "", "work", h.Server.Slug, "--once")
	if code == 0 || !strings.Contains(errOut, "CLAUDE_CODE_OAUTH_TOKEN") {
		t.Fatalf("work without agent credentials: %d %s", code, errOut)
	}
	if n := len(h.Server.Outcomes()); n != 0 {
		t.Fatalf("work claimed %d task(s) without credentials", n)
	}
	for _, bad := range [][]string{{"work", h.Server.Slug, "--budget", "lots"}, {"work", h.Server.Slug, "--schedule", "25:00-26:00"}, {"work", h.Server.Slug, "--max-concurrent", "0"}} {
		if code, _, _ := run(t, "", bad...); code != ExitUsage {
			t.Errorf("%v: exit %d, want usage error", bad, code)
		}
	}

	// The project moves on: work, dry-run and status all say to re-approve, and nothing is claimed.
	h.Repo.Write("src/later.py", []byte("# later\n"))
	newer := h.Repo.Commit("code moved")
	h.Server.Lock()
	h.Server.Commit = newer
	h.Server.Unlock()
	moved := "project moved to " + newer[:12] + "; run `agentfund approve " + ref + "` to review and approve it"
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "sk-ant-oat01-not-a-real-token-000000")
	// Unit tests never talk to a real container engine: point the worker at a stub CLI
	// that answers the start-up queries and records anything else.
	stubLog := useStubDocker(t)
	if code, _, errOut := run(t, "", "work", h.Server.Slug, "--once"); code != ExitNothing || !strings.Contains(errOut, moved) {
		t.Fatalf("work after the project moved: exit %d\n%s", code, errOut)
	}
	if calls, _ := os.ReadFile(stubLog); strings.Contains(string(calls), "UNEXPECTED") || !strings.Contains(string(calls), "version") {
		t.Fatalf("container CLI calls:\n%s", calls)
	}
	if n := len(h.Server.Outcomes()); n != 0 {
		t.Fatalf("%d claim(s) for an unapproved commit", n)
	}
	if out := mustRun(t, "", "dry-run", h.Server.Slug, "-n", "1"); !strings.Contains(out, "SKIPPED: "+moved) {
		t.Fatalf("dry-run after the project moved:\n%s", out)
	}
	if out := mustRun(t, "", "status"); !strings.Contains(out, "! "+moved) {
		t.Fatalf("status after the project moved:\n%s", out)
	}
	// With a follow policy that covers the new commit, status says so instead of asking for re-approval.
	mustRun(t, "", "approve", ref, "--yes", "--commit", h.Commit, "--follow-unchanged-lock")
	if out := mustRun(t, "", "status"); strings.Contains(out, "run `agentfund approve") || !strings.Contains(out, "covered by follow_unchanged_lock") {
		t.Fatalf("status with follow_unchanged_lock covering the new commit:\n%s", out)
	}
	if out := mustRun(t, "", "dry-run", h.Server.Slug, "-n", "1"); !strings.Contains(out, "WOULD RUN") {
		t.Fatalf("dry-run with follow_unchanged_lock:\n%s", out)
	}
	mustRun(t, "", "approve", ref, "--yes", "--commit", h.Commit, "--no-follow-unchanged-lock")
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", "")

	// Re-approval of the newer commit; the project is now reported as new with tight server caps.
	taskCap, dayCap := int64(500_000), int64(3_000_000)
	h.Server.Lock()
	h.Server.TrustTier, h.Server.TrustTaskCap, h.Server.TrustDayCap = "new", &taskCap, &dayCap
	h.Server.Unlock()
	out = mustRun(t, "", "approve", ref, "--yes")
	for _, want := range []string{`server trust tier:     "new"`, "treated as a NEW project", "per-task ceiling:      500k — server max_tokens_per_task binds",
		"your new_project_max_tokens_per_task 5M", "per-day for project:   3M — server max_tokens_per_day binds",
		"Will NOT run under the per-task ceiling: 0001-slugify (max_tokens 1M), 0002-truncate (max_tokens 1M), 0003-cli (max_tokens 1M)"} {
		if !strings.Contains(out, want) {
			t.Errorf("approve output lacks %q\n%s", want, out[strings.Index(out, "Trust and caps"):])
		}
	}
	if !strings.Contains(out, "Re-approval: previously approved commit "+h.Commit) {
		t.Fatalf("re-approve output:\n%s", out)
	}
	if cfg, _ := config.Load(); cfg.Projects[ref].ApprovedCommit != newer {
		t.Fatal("re-approval did not move the pin")
	}
	if out := mustRun(t, "", "status"); strings.Contains(out, "project moved") {
		t.Fatalf("status still asks for approval after re-approving:\n%s", out)
	}
}

func TestApproveRefusesKeyMismatch(t *testing.T) {
	isolate(t)
	allowFileRepos(t)
	h := apitest.NewHello(t, nil)
	ref := h.Server.URL + "/" + h.Server.Slug
	other := testutil.Key(t)

	// The server publishes a different key than the repository: refuse.
	h.Server.Lock()
	h.Server.Pubkey, h.Server.Fingerprint = other.Public().String(), other.Public().Fingerprint()
	h.Server.Unlock()
	code, out, errOut := run(t, "", "approve", ref, "--yes")
	if code == 0 || !strings.Contains(errOut, "does not verify") {
		t.Fatalf("approve with a server key that did not sign the lock: %d\n%s\n%s", code, out, errOut)
	}
	if cfg, _ := config.Load(); len(cfg.Projects) != 0 {
		t.Fatal("pinned despite a key mismatch")
	}
	// The donor can pin the key they verified out of band.
	out = mustRun(t, "", "approve", ref, "--yes", "--pubkey", h.Key.Public().String())
	if !strings.Contains(out, "pinning the key you passed with --pubkey") {
		t.Fatalf("approve --pubkey:\n%s", out)
	}
	if cfg, _ := config.Load(); cfg.Projects[ref].Pubkey != h.Key.Public().String() {
		t.Fatal("--pubkey was not pinned")
	}

	// Repo publishes another key in agentfund.yaml than the one that signs and the server registers:
	// the two channels disagree, so approve refuses even though the signature itself is fine.
	isolate(t)
	allowFileRepos(t)
	h2 := apitest.NewHello(t, func(repo *testutil.Repo) {
		raw := repo.Read("agentfund.yaml")
		lines := strings.Split(string(raw), "\n")
		for i, l := range lines {
			if strings.HasPrefix(l, "pubkey:") {
				lines[i] = "pubkey: " + other.Public().String()
			}
		}
		repo.Write("agentfund.yaml", []byte(strings.Join(lines, "\n")))
	})
	code, _, errOut = run(t, "", "approve", h2.Server.URL+"/"+h2.Server.Slug, "--yes")
	if code == 0 || !strings.Contains(errOut, "DIFFER") || !strings.Contains(errOut, "--pubkey") {
		t.Fatalf("approve when repo and server keys differ: %d %s", code, errOut)
	}
	// A server that lies about the fingerprint of its own key is refused too.
	isolate(t)
	allowFileRepos(t)
	h3 := apitest.NewHello(t, nil)
	h3.Server.Lock()
	h3.Server.Fingerprint = "SHA256:" + strings.Repeat("0", 64)
	h3.Server.Unlock()
	if code, _, errOut := run(t, "", "approve", h3.Server.URL+"/"+h3.Server.Slug, "--yes"); code == 0 || !strings.Contains(errOut, "pubkey_fingerprint") {
		t.Fatalf("approve with a bogus server fingerprint: %d %s", code, errOut)
	}
}

func TestDaemonInstall(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("unsupported OS")
	}
	isolate(t)
	home := t.TempDir()
	t.Setenv("HOME", home)
	allowFileRepos(t)
	h := apitest.NewHello(t, nil)
	mustRun(t, "", "approve", h.Server.URL+"/"+h.Server.Slug, "--yes")

	out := mustRun(t, "", "daemon", "install")
	if !strings.Contains(out, "Not started") || !strings.Contains(out, "claude_token_command") {
		t.Fatalf("daemon install output:\n%s", out)
	}
	var path string
	if runtime.GOOS == "darwin" {
		path = filepath.Join(home, "Library", "LaunchAgents", "dev.agentfund.worker.hello-project.plist")
	} else {
		path = filepath.Join(home, ".config", "systemd", "user", "agentfund-hello-project.service")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"work", h.Server.URL + "/hello-project", config.EnvConfigDir, config.EnvDataDir} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("service definition lacks %q:\n%s", want, raw)
		}
	}
	for _, secret := range []string{"CLAUDE_CODE_OAUTH_TOKEN=", "ANTHROPIC_API_KEY=", "af_"} {
		if strings.Contains(string(raw), secret) {
			t.Errorf("service definition must not embed credentials (%q):\n%s", secret, raw)
		}
	}
	if out := mustRun(t, "", "daemon", "uninstall"); !strings.Contains(out, "removed "+path) {
		t.Fatalf("daemon uninstall:\n%s", out)
	}
	if _, err := os.Stat(path); err == nil {
		t.Fatal("daemon uninstall left the service definition behind")
	}
	// The old spelling still works but is no longer advertised.
	mustRun(t, "", "daemon", "install")
	mustRun(t, "", "daemon", "install", "--uninstall")
	if _, err := os.Stat(path); err == nil {
		t.Fatal("daemon install --uninstall (hidden alias) left the service definition behind")
	}
	if help := mustRun(t, "", "daemon", "install", "--help"); strings.Contains(help, "--uninstall") {
		t.Fatalf("daemon install --help still advertises --uninstall:\n%s", help)
	}
}

func TestUsageErrors(t *testing.T) {
	isolate(t)
	for _, args := range [][]string{{"nope"}, {"work"}, {"approve"}, {"approve", "not-a-url"}, {"sign"}, {"validate"}, {"work", "x", "--bogus"}, {"dry-run", "x", "-n", "0"}} {
		code, _, errOut := run(t, "", args...)
		if code == 0 || errOut == "" {
			t.Errorf("%v: exit %d, stderr %q", args, code, errOut)
		}
	}
	welcome := mustRun(t, "")
	for _, want := range []string{"agentfund login <server-url>", "agentfund approve <server-url>/<project>", "agentfund dry-run <project>", "agentfund work <project>", "agentfund keygen", "agentfund sign tasks/", "--help"} {
		if !strings.Contains(welcome, want) {
			t.Errorf("no-argument screen lacks %q:\n%s", want, welcome)
		}
	}
	workHelp := mustRun(t, "", "work", "--help")
	for _, want := range []string{"\n  0 ", "\n  1 ", "\n  2 ", "\n  3 ", "\n  4 ", "\n  130 ", "a further limit for this invocation", "config caps still apply"} {
		if !strings.Contains(workHelp, want) {
			t.Errorf("work --help lacks %q", want)
		}
	}
	if out := mustRun(t, "", "version"); !strings.HasPrefix(out, "agentfund ") {
		t.Fatalf("version: %q", out)
	}
	for _, sub := range []string{"keygen", "sign", "validate", "login", "approve", "work", "dry-run", "status", "logs", "daemon"} {
		if out := mustRun(t, "", sub, "--help"); !strings.Contains(out, "Usage:") {
			t.Errorf("%s --help: %q", sub, out)
		}
	}
}

func TestResultLine(t *testing.T) {
	local := resultLine(pipeline.Result{Task: "0001-slugify", Outcome: "completed", TokensIn: 8100, TokensOut: 150,
		Branch: "agentfund/0001-slugify-00000000", PRURL: "file:///tmp/repo#agentfund/0001-slugify-00000000"})
	if local != "0001-slugify: completed (8,100 in / 150 out tokens) — branch agentfund/0001-slugify-00000000 pushed to file:///tmp/repo" {
		t.Errorf("local publisher line: %q", local)
	}
	gh := resultLine(pipeline.Result{Task: "0001-slugify", Outcome: "completed", TokensIn: 1_000_000, TokensOut: 2500, Branch: "b", PRURL: "https://github.com/a/b/pull/7"})
	if gh != "0001-slugify: completed (1,000,000 in / 2,500 out tokens) → https://github.com/a/b/pull/7" {
		t.Errorf("github line: %q", gh)
	}
	failed := resultLine(pipeline.Result{Task: "0002-x", Outcome: "failed", Reason: "verify command exited with code 1"})
	if failed != "0002-x: failed (0 in / 0 out tokens) — verify command exited with code 1" {
		t.Errorf("failure line: %q", failed)
	}
}
