//go:build integration

package pipeline

import (
	"bufio"
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/api"
	"github.com/ghvstcode/agentfund/worker/internal/apitest"
	"github.com/ghvstcode/agentfund/worker/internal/config"
	"github.com/ghvstcode/agentfund/worker/internal/gitx"
	"github.com/ghvstcode/agentfund/worker/internal/lockfile"
	"github.com/ghvstcode/agentfund/worker/internal/logs"
	"github.com/ghvstcode/agentfund/worker/internal/policy"
	"github.com/ghvstcode/agentfund/worker/internal/runner"
	"github.com/ghvstcode/agentfund/worker/internal/sandbox"
	"github.com/ghvstcode/agentfund/worker/internal/scope"
	"github.com/ghvstcode/agentfund/worker/internal/spec"
	"github.com/ghvstcode/agentfund/worker/internal/store"
	"github.com/ghvstcode/agentfund/worker/internal/testutil"
)

// Image names can be overridden to test against other builds.
func envOr(name, def string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return def
}

var (
	e2eImagePrefix = envOr("AGENTFUND_TEST_E2E_IMAGE_PREFIX", "agentfund/sandbox-e2e:")
	proxyImage     = envOr("AGENTFUND_TEST_EGRESS_PROXY_IMAGE", "agentfund/egress-proxy:dev")
	docker         = sandbox.CLI{Bin: "docker"}
	buildOnce      sync.Map
)

func dockerOut(t testing.TB, args ...string) string {
	t.Helper()
	out, err := exec.Command("docker", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("docker %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// ensureImages builds the scenario image (and the egress proxy) when missing.
func ensureImages(t testing.TB, scenario string) string {
	t.Helper()
	ctx := context.Background()
	if _, err := sandbox.Available(ctx, docker); err != nil {
		t.Fatalf("integration tests need Docker: %v", err)
	}
	root := testutil.Root(t)
	if !sandbox.ImagePresent(ctx, docker, proxyImage) {
		if _, done := buildOnce.LoadOrStore("proxy", true); !done {
			t.Logf("building %s from images/egress-proxy …", proxyImage)
			dockerOut(t, "build", "-q", "-t", proxyImage, filepath.Join(root, "images", "egress-proxy"))
		}
	}
	img := e2eImagePrefix + scenario
	if _, done := buildOnce.LoadOrStore(img, true); !done {
		ctxDir := filepath.Join(root, "images", "sandbox")
		arch := dockerOut(t, "version", "--format", "{{.Server.Arch}}")
		build := exec.Command("go", "build", "-o", filepath.Join(ctxDir, ".build", "mock-agent"), "./cmd/mock-agent")
		build.Dir = filepath.Join(root, "worker")
		build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+arch)
		if out, err := build.CombinedOutput(); err != nil {
			t.Fatalf("build mock agent: %v\n%s", err, out)
		}
		dockerOut(t, "build", "-q", "-f", filepath.Join(ctxDir, "Dockerfile.e2e"), "--build-arg", "MOCK_SCENARIO="+scenario, "-t", img, ctxDir)
	}
	return img
}

// integration wires the unit-test fixture to real Docker with a scenario image.
func integration(t *testing.T, scenario string, mutate func(repo *testutil.Repo)) *fixture {
	t.Helper()
	img := ensureImages(t, scenario)
	f := newFixture(t, mutate)
	f.w.Engine = docker
	f.w.Cfg.Global.Sandbox.Image = img
	f.w.Cfg.Global.Sandbox.EgressProxyImage = proxyImage
	f.w.Cfg.Global.Sandbox.Memory = "1g"
	// The docker CLI inherits the worker's real environment: that is how the
	// credential reaches `docker exec -e NAME` without touching argv.
	t.Setenv(runner.EnvOAuthToken, testSecret)
	t.Setenv(runner.EnvAPIKey, "")
	f.w.LookupEnv = nil
	t.Cleanup(func() { assertNoLeftovers(t) })
	return f
}

// assertNoLeftovers checks that this process left no sandbox resources behind.
// (Other test binaries may be running their own sandboxes at the same time.)
func assertNoLeftovers(t *testing.T) {
	t.Helper()
	mine := "label=" + sandbox.LabelPID + "=" + strconv.Itoa(os.Getpid())
	for _, q := range [][]string{
		{"ps", "-a", "--filter", mine, "--format", "{{.Names}}"},
		{"network", "ls", "--filter", mine, "--format", "{{.Name}}"},
		{"volume", "ls", "--filter", mine, "--format", "{{.Name}}"},
	} {
		if out := dockerOut(t, q...); out != "" {
			t.Errorf("sandbox resources left behind (docker %s): %s", q[0], out)
		}
	}
}

type logLine struct {
	Kind  string          `json:"kind"`
	Event json.RawMessage `json:"event"`
	Raw   map[string]any  `json:"-"`
}

func readLog(t *testing.T, path string) []logLine {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	var out []logLine
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 8<<20)
	for sc.Scan() {
		var l logLine
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			t.Fatalf("log line is not JSON: %q", sc.Text())
		}
		_ = json.Unmarshal(sc.Bytes(), &l.Raw)
		out = append(out, l)
	}
	return out
}

func kinds(lines []logLine) map[string]int {
	m := map[string]int{}
	for _, l := range lines {
		m[l.Kind]++
	}
	return m
}

// assertSecretNowhere greps everything the run produced or sent for the credential.
func assertSecretNowhere(t *testing.T, f *fixture, res Result) {
	t.Helper()
	check := func(what string, data []byte) {
		if bytes.Contains(data, []byte(testSecret)) || bytes.Contains(data, []byte("TESTSECRET")) {
			t.Errorf("the agent credential leaked into %s", what)
		}
	}
	if res.LogFile != "" {
		raw, err := os.ReadFile(res.LogFile)
		if err != nil {
			t.Fatal(err)
		}
		check("the run log", raw)
		if !bytes.Contains(raw, []byte(logs.Redacted)) {
			t.Errorf("the mock agent echoes its credential; the log should show %s where it was scrubbed", logs.Redacted)
		}
		side, err := os.ReadFile(logs.SidecarPath(res.LogFile))
		if err != nil {
			t.Fatalf("report sidecar: %v", err)
		}
		check("the report sidecar", side)
	}
	calls, _ := json.Marshal(f.srv.Calls(""))
	check("requests sent to the server", calls)
	out, _ := json.Marshal(f.srv.Outcomes())
	check("reports/releases/heartbeats", out)
	rj, _ := json.Marshal(res)
	check("the result", rj)
	_ = filepath.WalkDir(f.dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() || strings.Contains(p, string(filepath.Separator)+"repos"+string(filepath.Separator)) {
			return nil
		}
		b, _ := os.ReadFile(p)
		check("worker state file "+p, b)
		return nil
	})
	// Nothing in the origin repository either (objects are compressed, so ask git).
	for _, ref := range strings.Fields(f.repo.Git("for-each-ref", "--format=%(refname)")) {
		cmd := exec.Command("git", "-C", f.repo.Dir, "grep", "-l", "TESTSECRET", ref)
		if o, _ := cmd.Output(); len(o) > 0 {
			t.Errorf("the agent credential was pushed to %s: %s", ref, o)
		}
	}
}

func TestIntegrationHappyPath(t *testing.T) {
	f := integration(t, "happy", nil)
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Outcome != api.StatusCompleted {
		t.Fatalf("results: %+v", res)
	}
	r := res[0]
	// Mock usage: (1000+200+300) + (1100+1500) + (1200+2800) in; 50+70+30 out.
	const wantIn, wantOut = 8100, 150
	o := f.onlyOutcome()
	rep := o.Report
	wantBranch := "agentfund/0001-slugify-00000000"
	if o.Status != "reported" || rep["status"] != "completed" || rep["tokens_in"] != float64(wantIn) || rep["tokens_out"] != float64(wantOut) ||
		rep["branch"] != wantBranch || rep["pr_url"] != "file://"+f.repo.Dir+"#"+wantBranch || rep["verify_exit_code"] != float64(0) ||
		rep["cost_estimate"] != 0.0123 || rep["runner"] != "claude-code/0.0.0-mock" || rep["model"] != "mock-model-1" {
		t.Fatalf("report: %+v", rep)
	}
	if r.TokensIn != wantIn || r.TokensOut != wantOut || r.Branch != wantBranch {
		t.Fatalf("result: %+v", r)
	}

	// The branch exists in the origin, one commit on top of the claimed commit, touching only scope.write.
	head := f.repo.Git("rev-parse", "refs/heads/"+wantBranch)
	if head != rep["head_sha"] || f.repo.Git("rev-parse", head+"^") != f.commit {
		t.Fatalf("branch head %s (reported %v), parent should be %s", head, rep["head_sha"], f.commit)
	}
	if got := f.repo.Git("diff", "--name-status", f.commit, head); got != "A\tsrc/textutil.py\nA\ttests/test_slugify.py" {
		t.Fatalf("pushed diff:\n%s", got)
	}
	msg := f.repo.Git("log", "-1", "--format=%B", head)
	for _, want := range []string{"slugify() for titles", "AgentFund-Task: hello-project:0001-slugify", "AgentFund-Claim: " + o.ClaimID,
		"AgentFund-Manifest-SHA256: " + lockfile.SHA256Hex(f.repo.Read("tasks/0001-slugify.yaml"))} {
		if !strings.Contains(msg, want) {
			t.Errorf("commit message lacks %q:\n%s", want, msg)
		}
	}
	if f.repo.Git("rev-parse", "refs/heads/main") != f.commit {
		t.Error("main moved")
	}
	// The pushed code really passes the manifest's verify (run on the host copy of the branch).
	if !strings.Contains(f.repo.Git("show", head+":src/textutil.py"), "def slugify") {
		t.Error("pushed implementation is wrong")
	}

	// Log: digest, content, and what the agent saw inside the sandbox.
	raw, _ := os.ReadFile(r.LogFile)
	if lockfile.SHA256Hex(raw) != rep["log_digest"] {
		t.Fatal("log_digest is not the SHA-256 of the log file")
	}
	lines := readLog(t, r.LogFile)
	k := kinds(lines)
	for _, want := range []string{"claim", "verification", "manifest", "prompt", "policy", "sandbox", "agent", "agent_stderr", "agent_exit", "verify", "scope", "diff", "egress", "publish", "outcome"} {
		if k[want] == 0 {
			t.Errorf("log has no %q line (kinds: %v)", want, k)
		}
	}
	m, _ := spec.ParseManifest(f.repo.Read("tasks/0001-slugify.yaml"))
	var init struct {
		Cwd  string `json:"cwd"`
		Mock struct {
			UID           int      `json:"uid"`
			PromptBytes   int      `json:"prompt_bytes"`
			PromptHead    string   `json:"prompt_head"`
			HasOAuthToken bool     `json:"has_oauth_token"`
			HasAPIKey     bool     `json:"has_api_key"`
			HTTPSProxy    string   `json:"https_proxy"`
			SSLCertFile   string   `json:"ssl_cert_file"`
			NodeExtraCA   string   `json:"node_extra_ca_certs"`
			HasGitDir     bool     `json:"has_git_dir"`
			Args          []string `json:"args"`
		} `json:"mock"`
	}
	for _, l := range lines {
		if l.Kind == "agent" && bytes.Contains(l.Event, []byte(`"subtype":"init"`)) {
			if err := json.Unmarshal(l.Event, &init); err != nil {
				t.Fatal(err)
			}
		}
		if l.Kind == "prompt" && l.Raw["prompt"] != m.Prompt {
			t.Errorf("logged prompt differs from the manifest prompt")
		}
		if l.Kind == "verify" && (l.Raw["exit_code"] != float64(0) || !strings.Contains(l.Raw["output"].(string), "OK")) {
			t.Errorf("verify line: %+v", l.Raw)
		}
	}
	if init.Cwd != "/work" || init.Mock.UID != scope.AgentUID || init.Mock.PromptBytes != len(m.Prompt) || !strings.HasPrefix(m.Prompt, init.Mock.PromptHead) ||
		!init.Mock.HasOAuthToken || init.Mock.HasAPIKey || init.Mock.HTTPSProxy != "http://egress-proxy:3128" || init.Mock.HasGitDir ||
		init.Mock.SSLCertFile != "" || init.Mock.NodeExtraCA != "" {
		t.Fatalf("what the agent saw in the sandbox: %+v", init)
	}
	if strings.Contains(strings.Join(init.Mock.Args, " "), "Implement") {
		t.Error("the prompt was passed in argv")
	}
	assertSecretNowhere(t, f, r)

	// Local accounting settled to actual usage.
	st, _ := f.w.Store.Snapshot()
	g, _, active := store.UsageOf(st, time.Now(), f.w.Ref.Key())
	if g.Day != wantIn+wantOut || active != 0 || st.Runs[0].Status != "completed" || st.Runs[0].PRURL == "" {
		t.Fatalf("store after run: usage %+v active %d runs %+v", g, active, st.Runs)
	}
	// The sidecar holds the report that was sent.
	side, _ := os.ReadFile(logs.SidecarPath(r.LogFile))
	if !bytes.Contains(side, []byte(`"status": "completed"`)) || !bytes.Contains(side, []byte(rep["log_digest"].(string))) {
		t.Errorf("sidecar: %s", side)
	}
	// A second pass finds nothing claimable (the task awaits CI).
	if _, err := f.once(); !errors.Is(err, ErrNothingToDo) {
		t.Fatalf("second pass: %v", err)
	}
}

func TestIntegrationScopeViolation(t *testing.T) {
	f := integration(t, "scope", nil)
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != api.StatusVerificationFailed || o.Report["status"] != api.StatusVerificationFailed {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	if msg := o.Report["message"].(string); !strings.Contains(msg, "src/backdoor.py") || !strings.Contains(msg, "outside scope.write") {
		t.Fatalf("message %q", msg)
	}
	if o.Report["branch"] != nil || o.Report["pr_url"] != nil || o.Report["head_sha"] != nil {
		t.Fatalf("a discarded run must not name a branch: %+v", o.Report)
	}
	if o.Report["tokens_in"] != float64(8100) {
		t.Fatalf("burned tokens must still be reported: %+v", o.Report)
	}
	f.noBranchPushed()
	assertSecretNowhere(t, f, res[0])
}

func TestIntegrationCredentialInDiffIsDiscarded(t *testing.T) {
	f := integration(t, "leak", nil)
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || o.Report["status"] != api.StatusVerificationFailed || !strings.Contains(o.Report["message"].(string), "credential") {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	f.noBranchPushed()
	assertSecretNowhere(t, f, res[0])
}

func TestIntegrationBudgetKill(t *testing.T) {
	f := integration(t, "budget", nil)
	start := time.Now()
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != api.StatusBudgetExceeded || o.Report["status"] != api.StatusBudgetExceeded {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	total := o.Report["tokens_in"].(float64) + o.Report["tokens_out"].(float64)
	if float64(res[0].TokensIn+res[0].TokensOut) != total || o.Report["tokens_out"].(float64) == 0 {
		t.Fatalf("tokens burned up to the kill must be reported: result %+v report %+v", res[0], o.Report)
	}
	if total < 1_000_000 || total > 1_400_000 {
		t.Fatalf("killed at %v tokens; the cap is 1,000,000 and the mock burns 105k per step", total)
	}
	if time.Since(start) > 2*time.Minute {
		t.Fatalf("budget kill took %s", time.Since(start))
	}
	// Heartbeats carried cumulative usage and the phase while it ran.
	sawAgent := false
	var last float64
	for _, hb := range o.Heartbeats {
		if hb["phase"] == api.PhaseAgent {
			sawAgent = true
		}
		if in, ok := hb["tokens_in"].(float64); ok {
			if in < last {
				t.Errorf("heartbeat tokens went backwards: %v after %v", in, last)
			}
			last = in
		}
	}
	if len(o.Heartbeats) == 0 || !sawAgent || last == 0 {
		t.Fatalf("heartbeats: %+v", o.Heartbeats)
	}
	f.noBranchPushed()
	st, _ := f.w.Store.Snapshot()
	if g, _, _ := store.UsageOf(st, time.Now(), f.w.Ref.Key()); float64(g.Day) != total {
		t.Fatalf("store usage %d, reported %v", g.Day, total)
	}
}

func TestIntegrationTimeout(t *testing.T) {
	if testing.Short() {
		t.Skip("waits for the one-minute minimum timeout")
	}
	f := integration(t, "hang", func(repo *testutil.Repo) {
		p := "tasks/0001-slugify.yaml"
		repo.Write(p, bytes.Replace(repo.Read(p), []byte("timeout_minutes: 20"), []byte("timeout_minutes: 1"), 1))
	})
	start := time.Now()
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != api.StatusTimeout || o.Report["status"] != api.StatusTimeout {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	if el := time.Since(start); el < 55*time.Second || el > 3*time.Minute {
		t.Fatalf("timeout after %s, want about one minute", el)
	}
	if o.Report["tokens_in"] != float64(700) || o.Report["tokens_out"] != float64(7) {
		t.Fatalf("tokens burned before the timeout must be reported: %+v", o.Report)
	}
	f.noBranchPushed()
}

func TestIntegrationVerifyFailure(t *testing.T) {
	f := integration(t, "verifyfail", nil)
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != api.StatusFailed || o.Report["status"] != api.StatusFailed {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	if code, ok := o.Report["verify_exit_code"].(float64); !ok || code == 0 {
		t.Fatalf("verify_exit_code: %v", o.Report["verify_exit_code"])
	}
	f.noBranchPushed()
	for _, l := range readLog(t, res[0].LogFile) {
		if l.Kind == "verify" && !strings.Contains(l.Raw["output"].(string), "FAILED") {
			t.Errorf("verify output not captured: %v", l.Raw["output"])
		}
	}
	// The task is open again on the server, but this worker does not burn tokens on it again right away.
	if _, err := f.once(); !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "retry_failed_after") {
		t.Fatalf("second pass after a failure: %v", err)
	}
	if n := len(f.srv.Outcomes()); n != 1 {
		t.Fatalf("%d claims; a failed task must not be retried immediately", n)
	}
	// With the cooldown disabled it is retried.
	f.w.Cfg.Global.RetryFailedAfter = "0"
	if _, err := f.once(); err != nil {
		t.Fatal(err)
	}
	if n := len(f.srv.Outcomes()); n != 2 {
		t.Fatalf("%d claims after disabling the cooldown, want 2", n)
	}
}

func TestIntegrationNoChanges(t *testing.T) {
	// verify must pass for the "no changes" branch to be reached, so use a manifest whose verify is independent of the agent.
	f := integration(t, "nochange", func(repo *testutil.Repo) {
		p := "tasks/0001-slugify.yaml"
		repo.Write(p, bytes.Replace(repo.Read(p), []byte(`verify: python3 -m unittest discover -s tests -p "test_slugify.py"`), []byte("verify: test -d src"), 1))
	})
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || o.Report["status"] != api.StatusFailed || !strings.Contains(o.Report["message"].(string), "changed nothing") {
		t.Fatalf("results %+v report %+v", res, o.Report)
	}
	f.noBranchPushed()
}

func TestIntegrationRateLimitReleasesAndBacksOff(t *testing.T) {
	f := integration(t, "ratelimit", nil)
	before := time.Now()
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != OutcomeReleased || o.Status != "released" || o.Report != nil {
		t.Fatalf("results %+v outcome %+v", res, o)
	}
	if o.Release["tokens_in"] != float64(400) || o.Release["tokens_out"] != float64(4) || !strings.Contains(o.Release["reason"].(string), "rate limited") {
		t.Fatalf("release body: %+v", o.Release)
	}
	st, _ := f.w.Store.Snapshot()
	// The mock says the window resets in 90 minutes: the backoff must not end before that.
	if st.Backoff.Attempts != 1 || st.Backoff.Until.Before(before.Add(89*time.Minute)) {
		t.Fatalf("backoff state: %+v", st.Backoff)
	}
	// While backing off, nothing is claimed.
	if _, err := f.once(); !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "backing off") {
		t.Fatalf("second pass: %v", err)
	}
	if n := len(f.srv.Outcomes()); n != 1 {
		t.Fatalf("%d claims; the worker must not claim during backoff", n)
	}
	f.noBranchPushed()
	assertSecretNowhere(t, f, res[0])
}

// An agent that never reaches the model API is the backer's network, not the
// task: the claim is released (no failed report, no retry cooldown) and the
// worker backs off as for a rate limit.
func TestIntegrationUnreachableAPIReleasesAndBacksOff(t *testing.T) {
	f := integration(t, "unreachable", nil)
	before := time.Now()
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || res[0].Outcome != OutcomeReleased || o.Status != "released" || o.Report != nil {
		t.Fatalf("results %+v outcome %+v", res, o)
	}
	if reason := o.Release["reason"].(string); !strings.Contains(reason, "unreachable") || !strings.Contains(reason, "ERR_PROXY_TUNNEL") {
		t.Fatalf("release reason: %q", reason)
	}
	st, _ := f.w.Store.Snapshot()
	if st.Backoff.Attempts != 1 || st.Backoff.Cause != policy.CauseUnreachable || st.Backoff.Until.Before(before.Add(policy.BackoffBase*8/10)) {
		t.Fatalf("backoff state: %+v", st.Backoff)
	}
	if _, err := f.once(); !errors.Is(err, ErrNothingToDo) || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("second pass: %v", err)
	}
	if n := len(f.srv.Outcomes()); n != 1 {
		t.Fatalf("%d claims; the worker must not claim during backoff", n)
	}
	// Once the backoff is over the same task is claimed again: no 24 h
	// retry_failed_after lockout as after a failed attempt.
	if err := f.w.Store.SetBackoff(policy.BackoffState{}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.once(); err != nil {
		t.Fatalf("third pass: %v", err)
	}
	if out := f.srv.Outcomes(); len(out) != 2 || out[1].Status != "released" {
		t.Fatalf("outcomes after the backoff: %+v", out)
	}
	f.noBranchPushed()
	assertSecretNowhere(t, f, res[0])
}

func TestIntegrationCredentialRejectionStopsTheWorker(t *testing.T) {
	f := integration(t, "autherror", nil)
	res, err := f.once()
	var fatal *ErrFatal
	if !errors.As(err, &fatal) || !strings.Contains(err.Error(), "authentication_failed") {
		t.Fatalf("want a fatal credential error, got %v", err)
	}
	o := f.onlyOutcome()
	if len(res) != 1 || o.Status != "released" || o.Report != nil {
		t.Fatalf("results %+v outcome %+v", res, o)
	}
}

func TestIntegrationShutdownReleasesClaim(t *testing.T) {
	f := integration(t, "hang", nil)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	var res []Result
	go func() {
		done <- f.w.Work(ctx, LoopOptions{Poll: 50 * time.Millisecond, OnResult: func(r Result) { res = append(res, r) }})
	}()
	// Wait until the agent is running in the sandbox (a heartbeat says so), then "press Ctrl-C".
	ok := apitest.WaitFor(context.Background(), 90*time.Second, func() bool {
		for _, o := range f.srv.Outcomes() {
			for _, hb := range o.Heartbeats {
				if hb["phase"] == api.PhaseAgent && hb["tokens_in"] == float64(700) {
					return true
				}
			}
		}
		return false
	})
	if !ok {
		cancel()
		t.Fatalf("the run never reached the agent phase: %+v", f.srv.Outcomes())
	}
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Work returned %v", err)
		}
	case <-time.After(90 * time.Second):
		t.Fatal("Work did not return after cancellation")
	}
	o := f.onlyOutcome()
	if o.Status != "released" || o.Report != nil || o.Release["tokens_in"] != float64(700) || !strings.Contains(o.Release["reason"].(string), "shutting down") {
		t.Fatalf("after shutdown: %+v", o)
	}
	if len(res) != 1 || res[0].Outcome != OutcomeReleased {
		t.Fatalf("results: %+v", res)
	}
	st, _ := f.w.Store.Snapshot()
	if _, _, active := store.UsageOf(st, time.Now(), f.w.Ref.Key()); active != 0 {
		t.Fatal("a run is still marked active after shutdown")
	}
	f.noBranchPushed()
}

// protocol.md §13: a worker whose heartbeat is answered claim-not-active stops
// and still sends its report, so the burned tokens stay visible (flagged late).
func TestIntegrationClaimLostStopsAndStillReports(t *testing.T) {
	for _, rejectLate := range []bool{false, true} {
		name := map[bool]string{false: "server stores the late report", true: "server answers 409"}[rejectLate]
		t.Run(name, func(t *testing.T) {
			f := integration(t, "hang", nil)
			f.srv.Lock()
			f.srv.HeartbeatProblemAfter = 2
			f.srv.RejectLateReports = rejectLate
			f.srv.Unlock()
			start := time.Now()
			res, err := f.once()
			if err != nil {
				t.Fatal(err)
			}
			if time.Since(start) > 2*time.Minute {
				t.Fatalf("stopping took %s", time.Since(start))
			}
			if len(res) != 1 || res[0].Outcome != api.StatusFailed || !strings.Contains(res[0].Reason, "claim lost") || res[0].TokensIn != 700 || res[0].TokensOut != 7 {
				t.Fatalf("results: %+v", res)
			}
			o := f.onlyOutcome()
			if o.Release != nil {
				t.Fatalf("a lost claim cannot be released: %+v", o)
			}
			reports := f.srv.Calls("/report")
			if len(reports) != 1 || reports[0].Body["status"] != api.StatusFailed || reports[0].Body["tokens_in"] != float64(700) ||
				reports[0].Body["tokens_out"] != float64(7) || !strings.Contains(reports[0].Body["message"].(string), "claim lost: lease no longer active") {
				t.Fatalf("report requests: %+v", reports)
			}
			side, _ := os.ReadFile(logs.SidecarPath(res[0].LogFile))
			if rejectLate {
				if o.Report != nil || !bytes.Contains(side, []byte("report_error")) || !bytes.Contains(side, []byte("claim-not-active")) {
					t.Fatalf("a refused late report must be logged, not stored: outcome %+v sidecar %s", o, side)
				}
			} else if o.Report == nil || !o.FlaggedLate || !bytes.Contains(side, []byte(`"flagged_late": true`)) {
				t.Fatalf("late report should be stored flagged_late: outcome %+v sidecar %s", o, side)
			}
			st, _ := f.w.Store.Snapshot()
			if g, _, active := store.UsageOf(st, time.Now(), f.w.Ref.Key()); g.Day != 707 || active != 0 {
				t.Fatalf("local accounting after a lost claim: %+v active=%d", g, active)
			}
			f.noBranchPushed()
		})
	}
}

// TestIntegrationSandboxIsolation exercises the sandbox directly: file
// permissions, read-only root, unprivileged user, and egress.
func TestIntegrationSandboxIsolation(t *testing.T) {
	img := ensureImages(t, "happy")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	t.Cleanup(func() { assertNoLeftovers(t) })

	key := testutil.Key(t)
	repo, commit := testutil.HelloRepo(t, key)
	raw := repo.Read("tasks/0001-slugify.yaml")
	m, _ := spec.ParseManifest(raw)
	entries, err := gitx.LsTree(ctx, repo.Dir, commit, "", true)
	if err != nil {
		t.Fatal(err)
	}
	plan, err := scope.NewPlan(ctx, entries, m, blobReader(repo.Dir))
	if err != nil {
		t.Fatal(err)
	}
	// The allowlist the worker computes for a GitHub project with default config.
	defaultAllow := (&Worker{Cfg: config.Default(), Runner: runner.NewClaudeCode()}).egressAllowlist("https://github.com/example/hello-project")
	if strings.Join(defaultAllow, ",") != "api.anthropic.com" {
		t.Fatalf("default egress allowlist: %v", defaultAllow)
	}
	s, err := sandbox.Start(ctx, docker, sandbox.Spec{
		RunID: "isolation-" + strings.ToLower(strings.ReplaceAll(t.Name()[:4], "_", "")) + "-1", Image: img, ProxyImage: proxyImage,
		CPUs: "1", Memory: "512m", PIDs: 128, AllowHosts: defaultAllow,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var tarBuf bytes.Buffer
	if err := plan.WriteTar(ctx, &tarBuf, blobReader(repo.Dir)); err != nil {
		t.Fatal(err)
	}
	if err := s.PutWorkTree(ctx, &tarBuf, plan.RootWritable()); err != nil {
		t.Fatal(err)
	}
	sh := func(script string) (int, string) {
		var out bytes.Buffer
		code, err := s.Exec(ctx, sandbox.ExecSpec{Cmd: []string{"sh", "-c", script}, Stdout: &out, Stderr: &out})
		if err != nil {
			t.Fatalf("exec: %v", err)
		}
		return code, strings.TrimSpace(out.String())
	}
	expect := func(name, script string, wantOK bool, wantOut string) {
		t.Helper()
		code, out := sh(script)
		if (code == 0) != wantOK || (wantOut != "" && !strings.Contains(out, wantOut)) {
			t.Errorf("%s: exit %d, output %q (want ok=%v, containing %q)", name, code, out, wantOK, wantOut)
		}
	}

	expect("runs as the unprivileged agent", "id -u; id -g; pwd", true, "10001\n10001\n/work")
	expect("no .git in the sandbox", "test ! -e .git && test ! -e /work/.git", true, "")
	expect("manifests and descriptor are absent", "test ! -e tasks && test ! -e agentfund.yaml", true, "")
	expect("scope.read applied: .github is absent", "test ! -e .github", true, "")
	expect("readable files are present", "cat README.md | head -1", true, "hello-project")
	expect("cannot modify a read-only file", "echo x >> README.md", false, "")
	expect("cannot modify a read-only file in a writable dir", "echo x >> src/__init__.py", false, "")
	expect("cannot delete a file it does not own", "rm -f src/__init__.py", false, "")
	expect("cannot rename a file it does not own", "mv tests/__init__.py tests/x.py", false, "")
	expect("cannot create files at the root", "touch /work/new.txt", false, "")
	expect("can create the files in scope.write", "echo ok > src/textutil.py && echo ok > tests/test_slugify.py && cat src/textutil.py", true, "ok")
	expect("root file system is read-only", "touch /usr/local/bin/x", false, "Read-only")
	expect("tmp and home are writable", "touch /tmp/x \"$HOME/y\" && echo fine", true, "fine")
	expect("no capabilities", "grep CapEff /proc/self/status", true, "0000000000000000")
	expect("no docker socket", "test ! -e /var/run/docker.sock", true, "")
	expect("cannot become root", "su -c id root </dev/null", false, "")
	expect("verify command works offline", `python3 -c "print('py ok')"`, true, "py ok")

	// Egress: everything not allowlisted is refused, with or without the proxy.
	expect("non-allowlisted host is denied by the proxy", "curl -sS -m 20 -o /dev/null https://example.com", false, "403")
	expect("plain HTTP through the proxy is refused", "curl -sS -m 20 -o /dev/null -w '%{http_code}' http://example.com", true, "405")
	expect("bypassing the proxy has no route", "curl -sS -m 8 --noproxy '*' -o /dev/null https://example.com", false, "")
	expect("direct connection to a public IP fails", "curl -sS -m 8 --noproxy '*' -o /dev/null https://1.1.1.1", false, "")
	expect("external DNS does not resolve inside the sandbox", "getent hosts example.com", false, "")
	expect("IP-literal CONNECT is refused", "curl -sS -m 20 -o /dev/null https://93.184.216.34", false, "403")
	expect("allowlisted host on another port is refused", "curl -sS -m 20 -o /dev/null https://api.anthropic.com:8443", false, "403")
	expect("the git host is not reachable by default", "curl -sS -m 20 -o /dev/null https://github.com", false, "403")

	// The allowlisted host works — when this machine has internet at all.
	if conn, err := net.DialTimeout("tcp", "api.anthropic.com:443", 5*time.Second); err == nil {
		conn.Close()
		code, out := sh("curl -sS -m 30 -o /dev/null -w '%{http_code}' https://api.anthropic.com/")
		if code != 0 || !regexp.MustCompile(`^[2345][0-9][0-9]$`).MatchString(out) {
			t.Errorf("allowlisted host should be reachable through the proxy: exit %d, %q", code, out)
		}
	} else {
		t.Logf("no route from this host to api.anthropic.com (%v): skipping the positive egress check", err)
	}

	proxyLines, err := s.ProxyLogs(ctx)
	if err != nil {
		t.Fatal(err)
	}
	joined := strings.Join(proxyLines, "\n")
	if !strings.Contains(joined, `"action":"deny"`) || !strings.Contains(joined, `"host":"example.com"`) || !strings.Contains(joined, "not_allowlisted") {
		t.Errorf("proxy log lacks the deny decision:\n%s", joined)
	}

	// What comes back out is exactly what the agent was allowed to do.
	tarStream, wait := s.TarWorkTree(ctx)
	changes, derr := scope.Diff(tarStream, sandbox.WorkRoot, plan, nil, scope.DefaultLimits)
	tarStream.Close()
	_ = wait()
	if derr != nil {
		t.Fatalf("diff: %v", derr)
	}
	if got := scope.Summary(changes); got != "A src/textutil.py (3 bytes)\nA tests/test_slugify.py (3 bytes)\n" {
		t.Fatalf("change set:\n%s", got)
	}

	// Kill really kills: exec afterwards fails.
	s.Kill()
	if code, _ := s.Exec(ctx, sandbox.ExecSpec{Cmd: []string{"true"}}); code == 0 {
		t.Error("exec succeeded after Kill")
	}
}

// writeTestCA writes a self-signed CA certificate to a temporary PEM file.
func writeTestCA(t *testing.T) string {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "agentfund-test-corp-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour), IsCA: true, BasicConstraintsValid: true}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "corp-ca.pem")
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

// The worker passes sandbox.extra_ca_certs through to the agent's environment.
func TestIntegrationExtraCACertsReachTheAgent(t *testing.T) {
	f := integration(t, "happy", nil)
	f.w.Cfg.Global.Sandbox.ExtraCACerts = writeTestCA(t)
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Outcome != api.StatusCompleted {
		t.Fatalf("results: %+v", res)
	}
	var init struct {
		Mock struct {
			SSLCertFile string `json:"ssl_cert_file"`
			NodeExtraCA string `json:"node_extra_ca_certs"`
		} `json:"mock"`
	}
	for _, l := range readLog(t, res[0].LogFile) {
		if l.Kind == "agent" && bytes.Contains(l.Event, []byte(`"subtype":"init"`)) {
			if err := json.Unmarshal(l.Event, &init); err != nil {
				t.Fatal(err)
			}
		}
		if l.Kind == "sandbox" && l.Raw["extra_ca_certs"] != f.w.Cfg.Global.Sandbox.ExtraCACerts {
			t.Errorf("sandbox log line lacks the CA path: %+v", l.Raw)
		}
	}
	if init.Mock.SSLCertFile != sandbox.CABundleFile || init.Mock.NodeExtraCA != sandbox.ExtraCAFile {
		t.Fatalf("agent environment: %+v", init.Mock)
	}
}

func TestIntegrationSandboxExtraCACerts(t *testing.T) {
	img := ensureImages(t, "happy")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	t.Cleanup(func() { assertNoLeftovers(t) })

	path := writeTestCA(t)
	// The path is on the host only (Colima, for one, cannot see the test's temp dir): the worker copies the contents in.
	extra, err := config.ReadCACerts(path)
	if err != nil {
		t.Fatal(err)
	}
	s, err := sandbox.Start(ctx, docker, sandbox.Spec{
		RunID: "extraca-" + strconv.FormatInt(time.Now().UnixNano()%1e9, 36), Image: img, ProxyImage: proxyImage,
		CPUs: "1", Memory: "256m", PIDs: 64, AllowHosts: []string{"api.anthropic.com"}, ExtraCACerts: extra,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	expect := func(name, script string, wantOK bool, wantOut string) {
		t.Helper()
		var out bytes.Buffer
		code, err := s.Exec(ctx, sandbox.ExecSpec{Cmd: []string{"sh", "-c", script}, Stdout: &out, Stderr: &out})
		if err != nil {
			t.Fatalf("exec: %v", err)
		}
		if got := strings.TrimSpace(out.String()); (code == 0) != wantOK || (wantOut != "" && !strings.Contains(got, wantOut)) {
			t.Errorf("%s: exit %d, output %q (want ok=%v, containing %q)", name, code, got, wantOK, wantOut)
		}
	}
	expect("agent sees the variables", `echo "$NODE_EXTRA_CA_CERTS $SSL_CERT_FILE"`, true, sandbox.ExtraCAFile+" "+sandbox.CABundleFile)
	expect("extra certificates are the donor's", "cat "+sandbox.ExtraCAFile, true, strings.TrimSpace(string(extra)))
	expect("bundle is the system roots plus the donor's", fmt.Sprintf(
		`sys=$(grep -c 'BEGIN CERTIFICATE' %s); all=$(grep -c 'BEGIN CERTIFICATE' %s); test "$sys" -gt 10 && test "$all" -eq $((sys+1)) && echo counted`,
		sandbox.SystemCABundle, sandbox.CABundleFile), true, "counted")
	expect("donor CA ends the bundle", "tail -c 600 "+sandbox.CABundleFile, true, strings.TrimSpace(string(extra))[len(extra)-200:])
	expect("files are root-owned and not writable", "stat -c '%u %a' "+sandbox.ExtraCAFile+" "+sandbox.CABundleFile+" "+sandbox.CADir+"; test ! -w "+sandbox.ExtraCAFile+" && test ! -w "+sandbox.CABundleFile+" && echo ro", true, "0 644\n0 644\n0 755\nro")
	expect("cannot overwrite the bundle", "echo x > "+sandbox.CABundleFile, false, "")
	expect("cannot remove the bundle", "rm -f "+sandbox.CABundleFile, false, "")
	expect("cannot add files beside it", "touch "+sandbox.CADir+"/evil.pem", false, "")
	expect("the bundle verifies the donor CA", "openssl verify -CAfile "+sandbox.CABundleFile+" "+sandbox.ExtraCAFile, true, ": OK")
}

func TestIntegrationOrphanCleanup(t *testing.T) {
	img := ensureImages(t, "happy")
	ctx := context.Background()
	t.Cleanup(func() { assertNoLeftovers(t) })
	// Simulate resources left by a dead worker: same labels, a pid that cannot exist.
	dockerOut(t, "network", "create", "--internal", "--label", sandbox.LabelRun+"=orphan-test", "--label", sandbox.LabelPID+"=2147483646", "agentfund-orphan-test-net")
	dockerOut(t, "volume", "create", "--label", sandbox.LabelRun+"=orphan-test", "--label", sandbox.LabelPID+"=2147483646", "agentfund-orphan-test-work")
	dockerOut(t, "run", "-d", "--name", "agentfund-orphan-test-sbx", "--label", sandbox.LabelRun+"=orphan-test", "--label", sandbox.LabelPID+"=2147483646",
		"--network", "agentfund-orphan-test-net", "--entrypoint", "sleep", img, "infinity")
	removed, err := sandbox.CleanOrphans(ctx, docker, store.PIDAlive)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]bool{}
	for _, r := range removed {
		got[r] = true
	}
	for _, want := range []string{"agentfund-orphan-test-sbx", "agentfund-orphan-test-work", "agentfund-orphan-test-net"} {
		if !got[want] {
			t.Errorf("orphan %s was not removed (removed: %v)", want, removed)
		}
	}
	if out := dockerOut(t, "ps", "-a", "--filter", "label="+sandbox.LabelRun+"=orphan-test", "--format", "{{.Names}}"); out != "" {
		t.Errorf("orphan container still exists: %s", out)
	}
}
