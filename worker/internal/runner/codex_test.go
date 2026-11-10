package runner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"testing"
	"time"
)

func codexFeed(m *CodexMeter, lines ...string) {
	for _, l := range lines {
		m.Feed([]byte(l))
	}
}

// Recorded from codex-cli 0.167.0 with a fake key and no route to the API: the
// CLI never fails on its own, it keeps "waiting for network".
func TestCodexMeterOnRealOfflineStream(t *testing.T) {
	f, err := os.Open("testdata/codex-0.167.0-no-network.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m := NewCodexMeter()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		m.Feed(sc.Bytes())
	}
	if !m.Unreachable() {
		t.Fatal("offline stream not detected as unreachable")
	}
	out := m.Outcome()
	if out.ResultSeen || out.Final || out.Total() != 0 || out.CredentialProblem != "" || out.RateLimited {
		t.Fatalf("outcome %+v", out)
	}
	if !strings.Contains(out.Message, "unreachable") || !strings.HasPrefix(out.NetworkProblem, "Reconnecting... waiting for network") {
		t.Fatalf("message %q network problem %q", out.Message, out.NetworkProblem)
	}
}

// Going offline after the model has answered is not "never reached the API".
func TestCodexNetworkProblemNeedsNoAnswerAtAll(t *testing.T) {
	offline := `{"type":"error","message":"Reconnecting... waiting for network (Connection failed: error sending request)"}`
	cases := []struct {
		name    string
		lines   []string
		network bool
	}{
		{"offline from the start", []string{`{"type":"thread.started","thread_id":"t"}`, `{"type":"turn.started"}`,
			`{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport."}}`,
			offline, offline, offline, offline}, true},
		{"offline after the agent started working", []string{`{"type":"turn.started"}`,
			`{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"ls"}}`,
			offline, offline, offline, offline}, false},
		{"offline after a completed turn", []string{`{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":0,"output_tokens":1}}`,
			offline, offline, offline, offline}, false},
		{"not offline for long enough", []string{offline, offline, offline}, false},
	}
	for _, c := range cases {
		m := NewCodexMeter()
		codexFeed(m, c.lines...)
		if got := m.Outcome().NetworkProblem; (got != "") != c.network {
			t.Errorf("%s: NetworkProblem=%q, want set=%v", c.name, got, c.network)
		}
	}
}

// Recorded from codex-cli 0.167.0 with a real ChatGPT Plus sign-in (the
// stripped auth.json the worker writes), task 0001-slugify of hello-project,
// 2026-11-10. The stream holds no account data; it is copied verbatim.
func TestCodexMeterOnRealChatGPTStream(t *testing.T) {
	f, err := os.Open("testdata/codex-0.167.0-chatgpt-task.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m := NewCodexMeter()
	changed := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if m.Feed(sc.Bytes()) {
			changed++
		}
	}
	out := m.Outcome()
	// turn.completed: input_tokens 73048 (cached_input_tokens 61824 is part of
	// it), output_tokens 750, reasoning_output_tokens 0.
	if out.TokensIn != 73048 || out.TokensOut != 750 || changed != 1 {
		t.Fatalf("usage %+v after %d changes", out.Usage, changed)
	}
	if !out.ResultSeen || !out.Final || out.IsError || out.RateLimited || out.CredentialProblem != "" || out.Message != "" || m.Unreachable() {
		t.Fatalf("outcome %+v", out)
	}
}

// Recorded from codex-cli 0.167.0 with a ChatGPT sign-in whose access token
// had a corrupted signature (2026-11-10): 401 from chatgpt.com, ten
// reconnects, then turn.failed. It used no tokens.
func TestCodexMeterOnRealRejectedChatGPTToken(t *testing.T) {
	feed := func(m *CodexMeter, name string, stderr bool) {
		f, err := os.Open("testdata/" + name)
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		sc := bufio.NewScanner(f)
		for sc.Scan() {
			if stderr {
				m.FeedStderr(sc.Bytes())
			} else {
				m.Feed(sc.Bytes())
			}
		}
	}
	// stdout alone must be enough: stderr wording is not an interface.
	m := NewCodexMeter()
	feed(m, "codex-0.167.0-chatgpt-bad-token.jsonl", false)
	out := m.Outcome()
	if out.CredentialProblem != "authentication_failed" || !out.IsError || !out.ResultSeen || out.Total() != 0 || out.RateLimited {
		t.Fatalf("stdout only: %+v", out)
	}
	if out.Message != "workspace routing discovery unauthorized (401)" {
		t.Fatalf("message %q", out.Message)
	}
	m = NewCodexMeter()
	feed(m, "codex-0.167.0-chatgpt-bad-token.stderr", true)
	if m.Outcome().CredentialProblem != "authentication_failed" {
		t.Fatalf("stderr only: %+v", m.Outcome())
	}
}

func TestCodexMeterAccounting(t *testing.T) {
	m := NewCodexMeter()
	codexFeed(m,
		`{"type":"thread.started","thread_id":"t"}`,
		`{"type":"turn.started"}`,
		`{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}`,
		`not json`,
	)
	if m.Usage().Total() != 0 {
		t.Fatal("usage before turn end")
	}
	if !m.Feed([]byte(`{"type":"turn.completed","usage":{"input_tokens":1200,"cached_input_tokens":1000,"output_tokens":300}}`)) {
		t.Fatal("turn.completed did not change usage")
	}
	out := m.Outcome()
	// cached_input_tokens is a subset of input_tokens: not added twice.
	if out.TokensIn != 1200 || out.TokensOut != 300 || !out.Final || !out.ResultSeen || out.IsError {
		t.Fatalf("outcome %+v", out)
	}
	codexFeed(m, `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":0,"output_tokens":10}}`)
	if u := m.Usage(); u.TokensIn != 1300 || u.TokensOut != 310 {
		t.Fatalf("two turns: %+v", u)
	}
}

func TestCodexMeterFailures(t *testing.T) {
	cases := []struct {
		name               string
		lines              []string
		cred               string
		rate, isErr, avail bool
	}{
		{"auth", []string{`{"type":"error","message":"unexpected status 401 Unauthorized: Incorrect API key provided"}`, `{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized"}}`}, "authentication_failed", false, true, true},
		{"quota", []string{`{"type":"turn.failed","error":{"message":"You exceeded your current quota, please check your plan and billing details. insufficient_quota"}}`}, "billing_error", false, true, true},
		{"usage limit", []string{`{"type":"turn.failed","error":{"message":"usage_limit_reached: try again at 5pm"}}`}, "", true, true, true},
		{"plain failure", []string{`{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`}, "", false, true, true},
		{"recovered network", []string{
			`{"type":"error","message":"Reconnecting... waiting for network (x)"}`, `{"type":"error","message":"Reconnecting... waiting for network (x)"}`,
			`{"type":"error","message":"Reconnecting... waiting for network (x)"}`, `{"type":"error","message":"Reconnecting... 2/5 (other)"}`,
			`{"type":"error","message":"Reconnecting... waiting for network (x)"}`,
		}, "", false, false, true},
	}
	for _, c := range cases {
		m := NewCodexMeter()
		codexFeed(m, c.lines...)
		out := m.Outcome()
		if out.CredentialProblem != c.cred || out.RateLimited != c.rate || out.IsError != c.isErr || m.Unreachable() == c.avail {
			t.Errorf("%s: %+v unreachable=%v", c.name, out, m.Unreachable())
		}
		if c.isErr && out.Message == "" {
			t.Errorf("%s: no message", c.name)
		}
	}
	m := NewCodexMeter()
	m.FeedStderr([]byte("ERROR codex_api: 401 Unauthorized"))
	if m.Outcome().CredentialProblem != "authentication_failed" {
		t.Error("credential problem on stderr not detected")
	}
}

func TestCodexCredentials(t *testing.T) {
	c := NewCodex()
	ctx := context.Background()
	if _, err := c.Credentials(ctx, env(nil), "", nil); err == nil || !strings.Contains(err.Error(), EnvCodexAPIKey) {
		t.Fatalf("no credentials: %v", err)
	}
	// Anthropic credentials are not Codex credentials.
	if _, err := c.Credentials(ctx, env(map[string]string{EnvAPIKey: "sk-ant-api03-bbbbbbbb"}), "", nil); err == nil {
		t.Fatal("ANTHROPIC_API_KEY accepted for codex")
	}
	got, err := c.Credentials(ctx, env(map[string]string{EnvOpenAIAPIKey: "sk-proj-aaaaaaaa", "OTHER": "x"}), "", nil)
	if err != nil || strings.Join(got.PassEnv, ",") != EnvOpenAIAPIKey || got.Secrets[0] != "sk-proj-aaaaaaaa" {
		t.Fatalf("openai key: %+v %v", got, err)
	}
	got, err = c.Credentials(ctx, env(nil), "printf 'sk-proj-fromcommand\\n'", nil)
	if err != nil || len(got.Env) != 1 || got.Env[0] != EnvCodexAPIKey+"=sk-proj-fromcommand" {
		t.Fatalf("token command: %+v %v", got, err)
	}
}

func TestCodexArgs(t *testing.T) {
	args := NewCodex().Args("")
	joined := strings.Join(args, " ")
	for _, want := range []string{"codex exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "--ephemeral", "--ignore-user-config", "--ignore-rules"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args lack %q: %s", want, joined)
		}
	}
	if args[len(args)-1] != "-" || strings.Contains(joined, "--model") {
		t.Errorf("args: %v", args)
	}
	if got := NewCodex().Args("gpt-5-codex"); got[len(got)-3] != "--model" || got[len(got)-2] != "gpt-5-codex" || got[len(got)-1] != "-" {
		t.Errorf("model args: %v", got)
	}
	if h := NewCodex().APIHosts(); len(h) != 1 || h[0] != CodexAPIHost {
		t.Errorf("hosts %v", h)
	}
}

func TestCodexRun(t *testing.T) {
	c := NewCodex()
	const prompt = "-\nDo the thing. $(id)\n"
	var gotPrompt string
	var gotPass, gotEnv []string
	var usages []Usage
	exec := func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		if len(cmd) == 2 && cmd[1] == "--version" {
			fmt.Fprintln(stdout, "codex-cli 0.167.0")
			return 0, nil
		}
		gotPass, gotEnv = pass, env
		b, _ := io.ReadAll(stdin)
		gotPrompt = string(b)
		fmt.Fprintln(stdout, `{"type":"thread.started","thread_id":"t"}`)
		fmt.Fprintln(stdout, `{"type":"turn.started"}`)
		fmt.Fprintln(stdout, `{"type":"turn.completed","usage":{"input_tokens":50,"cached_input_tokens":0,"output_tokens":7}}`)
		return 0, nil
	}
	out, err := c.Run(context.Background(), RunSpec{
		Prompt: prompt, Model: "gpt-x", Exec: exec,
		Creds:   Credentials{PassEnv: []string{EnvCodexAPIKey}},
		OnUsage: func(u Usage) { usages = append(usages, u) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPrompt != prompt || !strings.Contains(strings.Join(gotPass, ","), EnvCodexAPIKey) || !strings.Contains(strings.Join(gotEnv, ","), "NO_COLOR=1") {
		t.Fatalf("prompt %q pass %v env %v", gotPrompt, gotPass, gotEnv)
	}
	if out.Version != "codex/0.167.0" || out.Model != "gpt-x" || out.TokensIn != 50 || out.TokensOut != 7 || !out.ResultSeen || len(usages) != 1 {
		t.Fatalf("outcome %+v usages %v", out, usages)
	}
}

// An agent stuck waiting for the network is stopped by the runner itself.
func TestCodexRunStopsWhenAPIUnreachable(t *testing.T) {
	exec := func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		if cmd[1] == "--version" {
			return 1, nil
		}
		for i := 0; ; i++ {
			select {
			case <-ctx.Done():
				return 137, nil
			default:
			}
			fmt.Fprintln(stdout, `{"type":"error","message":"Reconnecting... waiting for network (Connection failed)"}`)
			if i > 1000 {
				return 0, nil
			}
			time.Sleep(time.Millisecond)
		}
	}
	done := make(chan Outcome, 1)
	go func() {
		out, _ := NewCodex().Run(context.Background(), RunSpec{Prompt: "x", Exec: exec})
		done <- out
	}()
	select {
	case out := <-done:
		if out.ExitCode != 137 || out.ResultSeen || out.Version != "codex" || !strings.Contains(out.Message, "unreachable") || out.NetworkProblem == "" {
			t.Fatalf("outcome %+v", out)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("runner did not stop an agent stuck offline")
	}
}
