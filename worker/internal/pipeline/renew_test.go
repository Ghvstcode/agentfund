package pipeline

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/ghvstcode/agentfund/worker/internal/runner"
)

// renewingRunner is Claude Code with credentials that expire, like Codex
// with a ChatGPT sign-in.
type renewingRunner struct {
	*runner.ClaudeCode
	hosts    []string
	renewErr error
	asked    []time.Duration
}

// refusingEngine lets the pipeline reach the sandbox step and then fails it.
type refusingEngine struct{ noSandboxEngine }

func (e *refusingEngine) Output(ctx context.Context, args ...string) (string, error) {
	switch args[0] {
	case "version", "image", "ps":
		return e.noSandboxEngine.Output(ctx, args...)
	}
	return "", errors.New("no sandbox in this test")
}

func (e *refusingEngine) Stream(ctx context.Context, _ io.Reader, _, _ io.Writer, _ []string, args ...string) (int, error) {
	_, err := e.Output(ctx, args...)
	return 1, err
}

const renewedSecret = "renewed-access-token-0123456789"

func (r *renewingRunner) Credentials(ctx context.Context, _ func(string) (string, bool), _ string, _ []string) (runner.Credentials, error) {
	return runner.Credentials{
		Hosts: r.hosts,
		Renew: func(ctx context.Context, validFor time.Duration) (runner.Credentials, error) {
			r.asked = append(r.asked, validFor)
			if r.renewErr != nil {
				return runner.Credentials{}, r.renewErr
			}
			return runner.Credentials{Hosts: r.hosts, Secrets: []string{renewedSecret}}, nil
		},
	}, nil
}

func TestCredentialsAreRenewedForEachRun(t *testing.T) {
	f := newFixture(t, nil)
	rr := &renewingRunner{ClaudeCode: runner.NewClaudeCode(), hosts: []string{"chatgpt.com"}}
	f.w.Runner = rr
	f.w.Engine = &refusingEngine{noSandboxEngine{t: t}}
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	// hello-project tasks have timeout_minutes: 20; the credential must
	// outlast the run with a margin.
	if len(rr.asked) != 1 || rr.asked[0] != 30*time.Minute {
		t.Fatalf("renew asked for %v", rr.asked)
	}
	if len(res) != 1 {
		t.Fatalf("results: %+v", res)
	}
	// The allowlist follows the credential, not the runner's default host.
	log, _ := os.ReadFile(res[0].LogFile)
	if !strings.Contains(string(log), `"egress_allowlist":["chatgpt.com"]`) || strings.Contains(string(log), "api.anthropic.com") {
		t.Fatalf("sandbox allowlist in the log:\n%s", log)
	}
}

func TestRenewalCredentialProblemStopsTheWorker(t *testing.T) {
	f := newFixture(t, nil)
	f.w.Runner = &renewingRunner{ClaudeCode: runner.NewClaudeCode(),
		renewErr: fmt.Errorf("%w: the Codex ChatGPT sign-in has to be renewed", runner.ErrCredentials)}
	_, err := f.once()
	var fatal *ErrFatal
	if !errors.As(err, &fatal) || !strings.Contains(err.Error(), "sign-in") {
		t.Fatalf("err = %v", err)
	}
	o := f.onlyOutcome()
	if o.Status != "released" || !strings.Contains(o.Release["reason"].(string), "credentials need attention") {
		t.Fatalf("server saw %+v", o)
	}
	f.noBranchPushed()
}

func TestRenewalTransientFailureReleasesOnly(t *testing.T) {
	f := newFixture(t, nil)
	f.w.Runner = &renewingRunner{ClaudeCode: runner.NewClaudeCode(), renewErr: errors.New("refresh the Codex sign-in: HTTP 502")}
	res, err := f.once()
	if err != nil {
		t.Fatal(err)
	}
	if len(res) != 1 || res[0].Outcome != OutcomeReleased || !strings.Contains(res[0].Reason, "HTTP 502") {
		t.Fatalf("results: %+v", res)
	}
}
