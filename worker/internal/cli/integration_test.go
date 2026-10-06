//go:build integration

package cli

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/agentfund/agentfund/worker/internal/apitest"
	"github.com/agentfund/agentfund/worker/internal/config"
	"github.com/agentfund/agentfund/worker/internal/pipeline"
	"github.com/agentfund/agentfund/worker/internal/testutil"
)

const cliSecret = "sk-ant-oat01-CLISECRET-must-never-be-stored-0123456789"

func e2eImage(t *testing.T, scenario string) string {
	t.Helper()
	root := testutil.Root(t)
	ctxDir := filepath.Join(root, "images", "sandbox")
	arch, err := exec.Command("docker", "version", "--format", "{{.Server.Arch}}").Output()
	if err != nil {
		t.Fatalf("integration tests need Docker: %v", err)
	}
	build := exec.Command("go", "build", "-o", filepath.Join(ctxDir, ".build", "mock-agent"), "./cmd/mock-agent")
	build.Dir = filepath.Join(root, "worker")
	build.Env = append(os.Environ(), "CGO_ENABLED=0", "GOOS=linux", "GOARCH="+strings.TrimSpace(string(arch)))
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build mock agent: %v\n%s", err, out)
	}
	img := "agentfund/sandbox-e2e:" + scenario
	if out, err := exec.Command("docker", "build", "-q", "-f", filepath.Join(ctxDir, "Dockerfile.e2e"), "--build-arg", "MOCK_SCENARIO="+scenario, "-t", img, ctxDir).CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", img, err, out)
	}
	return img
}

// TestIntegrationCLIEndToEnd drives the whole donor flow through the CLI the
// way an end-to-end script would: login → approve → dry-run → work --once →
// status → logs, with state directories and images taken from the environment.
func TestIntegrationCLIEndToEnd(t *testing.T) {
	cfgDir, dataDir := isolate(t)
	allowFileRepos(t)
	h := apitest.NewHello(t, nil)
	ref := h.Server.URL + "/" + h.Server.Slug
	proxy := "agentfund/egress-proxy:dev"
	if v := os.Getenv("AGENTFUND_TEST_EGRESS_PROXY_IMAGE"); v != "" {
		proxy = v
	}
	t.Setenv(EnvSandboxImage, e2eImage(t, "happy"))
	t.Setenv(EnvProxyImage, proxy)
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", cliSecret)

	mustRun(t, h.Server.APIKey+"\n", "login", h.Server.URL, "--key-stdin")
	mustRun(t, "", "approve", ref, "--yes")
	if out := mustRun(t, "", "dry-run", h.Server.Slug, "-n", "1"); !strings.Contains(out, "WOULD RUN") {
		t.Fatalf("dry-run:\n%s", out)
	}

	code, stdout, stderr := run(t, "", "work", h.Server.Slug, "--once", "--json", "--task", "0001-slugify", "--budget", "2m")
	if code != ExitOK {
		t.Fatalf("work --once: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	var res pipeline.Result
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &res); err != nil {
		t.Fatalf("work --json output is not one JSON object: %q (%v)", stdout, err)
	}
	if res.Outcome != "completed" || res.TokensIn != 8100 || res.TokensOut != 150 || res.Branch != "agentfund/0001-slugify-00000000" || res.PRURL == "" || len(res.LogDigest) != 64 {
		t.Fatalf("result: %+v", res)
	}
	if h.Repo.Git("rev-parse", "refs/heads/"+res.Branch) != res.HeadSHA {
		t.Fatal("branch was not pushed")
	}

	status := mustRun(t, "", "status")
	for _, want := range []string{"8250 of 10m", "completed", "0001-slugify", res.Claim, "none"} {
		if !strings.Contains(status, want) {
			t.Errorf("status lacks %q:\n%s", want, status)
		}
	}
	if list := mustRun(t, "", "logs"); !strings.Contains(list, res.Claim) {
		t.Fatalf("logs list:\n%s", list)
	}
	logOut := mustRun(t, "", "logs", res.Claim)
	if !strings.Contains(logOut, `"kind":"prompt"`) || !strings.Contains(logOut, "[REDACTED]") {
		t.Fatalf("logs output lacks the prompt or the redaction marker")
	}
	if rep := mustRun(t, "", "logs", res.Claim, "--report"); !strings.Contains(rep, res.LogDigest) || !strings.Contains(rep, `"status": "completed"`) {
		t.Fatalf("report sidecar:\n%s", rep)
	}

	// Nothing claimable any more: distinct exit status.
	if code, _, errOut := run(t, "", "work", h.Server.Slug, "--once"); code != ExitNothing {
		t.Fatalf("second work --once: exit %d (%s)", code, errOut)
	}

	// The maintainer merges the branch; the server follows to the new head and the dependent task opens.
	h.Repo.Git("merge", "-q", "--no-ff", res.Branch, "-m", "Merge "+res.Branch)
	merged := h.Repo.Git("rev-parse", "HEAD")
	h.Server.Lock()
	h.Server.Commit = merged
	h.Server.Tasks[1].Claimable = true
	h.Server.Unlock()
	claimsBefore := len(h.Server.Outcomes())
	code, _, errOut := run(t, "", "work", h.Server.Slug, "--once", "--json")
	if code != ExitNothing || !strings.Contains(errOut, "project moved to "+merged[:12]) || !strings.Contains(errOut, "agentfund approve "+ref) {
		t.Fatalf("work on an unapproved newer commit: exit %d\n%s", code, errOut)
	}
	if len(h.Server.Outcomes()) != claimsBefore {
		t.Fatal("a task was claimed at a commit the donor never approved")
	}
	mustRun(t, "", "approve", ref, "--yes")
	code, stdout, stderr = run(t, "", "work", h.Server.Slug, "--once", "--json")
	if code != ExitOK {
		t.Fatalf("work after re-approval: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	var res2 pipeline.Result
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &res2); err != nil || res2.Outcome != "completed" || res2.Task != "0002-truncate" ||
		res2.ReportAccepted == nil || !*res2.ReportAccepted {
		t.Fatalf("second task: %+v (%v)", res2, err)
	}
	if got := h.Repo.Git("diff", "--name-status", merged, res2.HeadSHA); got != "M\tsrc/textutil.py\nA\ttests/test_truncate.py" {
		t.Fatalf("second task's pushed diff:\n%s", got)
	}

	// The agent credential is nowhere on disk under the worker's directories, and never reached the server.
	for _, dir := range []string{cfgDir, dataDir} {
		_ = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			b, _ := os.ReadFile(p)
			if strings.Contains(string(b), "CLISECRET") {
				t.Errorf("agent credential found in %s", p)
			}
			return nil
		})
	}
	calls, _ := json.Marshal(h.Server.Calls(""))
	if strings.Contains(string(calls), "CLISECRET") {
		t.Error("agent credential was sent to the server")
	}
	if strings.Contains(stdout+stderr+status+logOut, "CLISECRET") {
		t.Error("agent credential was printed")
	}
	creds, _ := os.ReadFile(config.CredentialsPath())
	if !strings.Contains(string(creds), h.Server.APIKey) {
		t.Error("server API key should be in credentials.yaml")
	}
}

// A report the server refuses must not look like success.
func TestIntegrationRefusedReportIsNotSuccess(t *testing.T) {
	isolate(t)
	allowFileRepos(t)
	h := apitest.NewHello(t, nil)
	proxy := "agentfund/egress-proxy:dev"
	if v := os.Getenv("AGENTFUND_TEST_EGRESS_PROXY_IMAGE"); v != "" {
		proxy = v
	}
	t.Setenv(EnvSandboxImage, e2eImage(t, "happy"))
	t.Setenv(EnvProxyImage, proxy)
	t.Setenv("CLAUDE_CODE_OAUTH_TOKEN", cliSecret)
	t.Setenv(config.EnvAPIKey, h.Server.APIKey)
	mustRun(t, "", "approve", h.Server.URL+"/"+h.Server.Slug, "--yes")
	h.Server.Lock()
	h.Server.ReportProblem = "validation"
	h.Server.Unlock()

	code, stdout, stderr := run(t, "", "work", h.Server.Slug, "--once", "--json")
	if code != ExitNotDone || !strings.Contains(stderr, "did not accept the report") {
		t.Fatalf("work --once with a refused report: exit %d\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	var res pipeline.Result
	if err := json.Unmarshal([]byte(strings.TrimSpace(stdout)), &res); err != nil {
		t.Fatalf("--json output: %q (%v)", stdout, err)
	}
	if res.ReportAccepted == nil || *res.ReportAccepted || !strings.Contains(res.ReportError, "validation") || res.Outcome != "completed" || res.TokensIn != 8100 {
		t.Fatalf("result: %+v", res)
	}
	if !strings.Contains(stdout, `"report_accepted":false`) || !strings.Contains(stdout, `"report_error":"`) {
		t.Fatalf("--json line lacks report_accepted/report_error: %s", stdout)
	}
	if status := mustRun(t, "", "status"); !strings.Contains(status, "REPORT NOT ACCEPTED") {
		t.Fatalf("status does not show the refusal:\n%s", status)
	}
}
