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

func feedAll(t *testing.T, m *Meter, lines ...string) {
	t.Helper()
	for _, l := range lines {
		m.Feed([]byte(l))
	}
}

func start(id string, in, cacheCreate, cacheRead, out int, parent string) string {
	p := "null"
	if parent != "" {
		p = `"` + parent + `"`
	}
	return fmt.Sprintf(`{"type":"stream_event","event":{"type":"message_start","message":{"id":%q,"usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d}}},"parent_tool_use_id":%s}`,
		id, in, cacheCreate, cacheRead, out, p)
}

func delta(out int, parent string) string {
	p := "null"
	if parent != "" {
		p = `"` + parent + `"`
	}
	return fmt.Sprintf(`{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":%d}},"parent_tool_use_id":%s}`, out, p)
}

func assistant(id string, in, cacheCreate, cacheRead, out int) string {
	return fmt.Sprintf(`{"type":"assistant","message":{"id":%q,"model":"m","usage":{"input_tokens":%d,"cache_creation_input_tokens":%d,"cache_read_input_tokens":%d,"output_tokens":%d}},"parent_tool_use_id":null}`,
		id, in, cacheCreate, cacheRead, out)
}

// The fixture is a real (sanitised) stream captured from Claude Code 2.1.289.
func TestMeterOnRealStream(t *testing.T) {
	f, err := os.Open("testdata/real-2.1.289-simple.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	m := NewMeter()
	sc := bufio.NewScanner(f)
	sc.Buffer(nil, 1<<20)
	var beforeResult Usage
	for sc.Scan() {
		if strings.Contains(sc.Text(), `"type":"result"`) {
			beforeResult = m.Usage()
		}
		m.Feed(sc.Bytes())
	}
	// In-flight accounting (one message id, three events carrying its usage) must already be exact.
	if beforeResult.TokensIn != 3801 || beforeResult.TokensOut != 43 {
		t.Fatalf("in-flight usage %+v, want in=3801 out=43 (no double counting, placeholder output replaced)", beforeResult)
	}
	o := m.Outcome()
	if o.TokensIn != 3801 || o.TokensOut != 43 || !o.Final || !o.ResultSeen || o.IsError || o.RateLimited ||
		o.Model != "claude-haiku-4-5-20251001" || o.Version != "claude-code/2.1.289" || o.CostUSD < 0.004 || o.CostUSD > 0.0041 || o.CredentialProblem != "" {
		t.Fatalf("outcome %+v", o)
	}
	if o.ResetAt.IsZero() {
		t.Error("rate_limit_event reset time not captured")
	}
}

func TestMeterAccounting(t *testing.T) {
	t.Run("input side sums input + cache creation + cache read", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 20, 3000, 1, ""), delta(50, ""))
		if u := m.Usage(); u.TokensIn != 3120 || u.TokensOut != 50 || u.Total() != 3170 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("same message id is counted once across start, parallel assistants and deltas", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 0, 0, 2, ""), assistant("msg_1", 100, 0, 0, 2), assistant("msg_1", 100, 0, 0, 2),
			delta(10, ""), delta(30, ""), assistant("msg_1", 100, 0, 0, 2), delta(30, ""))
		if u := m.Usage(); u.TokensIn != 100 || u.TokensOut != 30 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("several model calls accumulate", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 0, 0, 1, ""), delta(40, ""), start("msg_2", 150, 0, 100, 1, ""), delta(60, ""), start("msg_3", 10, 5, 0, 1, ""))
		if u := m.Usage(); u.TokensIn != 100+250+15 || u.TokensOut != 40+60+1 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("without partial messages assistant events alone are metered", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, assistant("msg_1", 100, 0, 0, 5), assistant("msg_2", 200, 0, 0, 7))
		if u := m.Usage(); u.TokensIn != 300 || u.TokensOut != 12 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("sub-agent calls are metered separately from the main loop", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_main", 100, 0, 0, 1, ""), start("msg_sub", 500, 0, 0, 1, "toolu_1"), delta(70, "toolu_1"), delta(20, ""))
		if u := m.Usage(); u.TokensIn != 600 || u.TokensOut != 90 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("final result totals replace the running sum (no double counting)", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 0, 0, 1, ""), delta(40, ""), start("msg_2", 150, 0, 0, 1, ""), delta(60, ""))
		m.Feed([]byte(`{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.5,"usage":{"input_tokens":250,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":100}}`))
		o := m.Outcome()
		if o.TokensIn != 250 || o.TokensOut != 100 || !o.Final || o.CostUSD != 0.5 {
			t.Fatalf("%+v", o)
		}
	})
	t.Run("modelUsage (includes sub-agents) wins over result.usage", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 0, 0, 1, ""))
		m.Feed([]byte(`{"type":"result","subtype":"success","total_cost_usd":1.25,"usage":{"input_tokens":100,"output_tokens":10},"modelUsage":{"opus":{"inputTokens":100,"outputTokens":10,"cacheReadInputTokens":1000,"cacheCreationInputTokens":50},"haiku":{"inputTokens":400,"outputTokens":40,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}`))
		o := m.Outcome()
		if o.TokensIn != 100+1000+50+400 || o.TokensOut != 50 || o.CostUSD != 1.25 {
			t.Fatalf("%+v", o)
		}
	})
	t.Run("a zeroed crash result keeps the running sum", func(t *testing.T) {
		m := NewMeter()
		feedAll(t, m, start("msg_1", 100, 0, 0, 1, ""), delta(40, ""))
		m.Feed([]byte(`{"type":"result","subtype":"error_during_execution","is_error":true,"total_cost_usd":0,"usage":{"input_tokens":0,"output_tokens":0},"modelUsage":{}}`))
		o := m.Outcome()
		if o.TokensIn != 100 || o.TokensOut != 40 || o.Final || !o.IsError || !o.ResultSeen || o.Message != "error_during_execution" {
			t.Fatalf("%+v", o)
		}
	})
	t.Run("garbage lines are ignored", func(t *testing.T) {
		m := NewMeter()
		for _, l := range []string{"", "not json", "[1,2]", `{"type":`, `{"type":"assistant"}`, `{"type":"stream_event"}`, `{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":99}}}`, `{"type":"result"}`, "\x00\x01"} {
			m.Feed([]byte(l))
		}
		if u := m.Usage(); u.Total() != 0 {
			t.Fatalf("%+v", u)
		}
	})
	t.Run("Feed reports changes", func(t *testing.T) {
		m := NewMeter()
		if !m.Feed([]byte(start("msg_1", 1, 0, 0, 0, ""))) || m.Feed([]byte(start("msg_1", 1, 0, 0, 0, ""))) || !m.Feed([]byte(delta(5, ""))) {
			t.Fatal("change detection wrong")
		}
	})
}

func TestMeterRateLimitAndCredentialDetection(t *testing.T) {
	cases := []struct {
		name        string
		lines       []string
		rateLimited bool
		credential  string
	}{
		{"assistant rate_limit error", []string{`{"type":"assistant","error":"rate_limit","message":{"id":"m","usage":{"input_tokens":1,"output_tokens":1}}}`}, true, ""},
		{"assistant overloaded error", []string{`{"type":"assistant","error":"overloaded","message":{"id":"m"}}`}, true, ""},
		{"rate_limit_event rejected", []string{`{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791324000,"rateLimitType":"five_hour"}}`}, true, ""},
		{"rate_limit_event allowed", []string{`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1791324000}}`}, false, ""},
		{"rate_limit_event allowed_warning", []string{`{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1791324000}}`}, false, ""},
		{"result with HTTP 429", []string{`{"type":"result","subtype":"success","is_error":true,"api_error_status":429,"result":"API Error: 429"}`}, true, ""},
		{"result with HTTP 529", []string{`{"type":"result","is_error":true,"api_error_status":529}`}, true, ""},
		{"one api_retry is tolerated", []string{`{"type":"system","subtype":"api_retry","attempt":1,"error":"rate_limit","error_status":429}`}, false, ""},
		{"api_retry that recovers resets the count", []string{
			`{"type":"system","subtype":"api_retry","attempt":1,"error":"rate_limit"}`, `{"type":"system","subtype":"api_retry","attempt":2,"error":"rate_limit"}`,
			start("msg_1", 1, 0, 0, 1, ""),
			`{"type":"system","subtype":"api_retry","attempt":1,"error":"rate_limit"}`, `{"type":"system","subtype":"api_retry","attempt":2,"error":"rate_limit"}`}, false, ""},
		{"three consecutive api_retry give up", []string{
			`{"type":"system","subtype":"api_retry","attempt":1,"error":"rate_limit"}`, `{"type":"system","subtype":"api_retry","attempt":2,"error":"overloaded"}`,
			`{"type":"system","subtype":"api_retry","attempt":3,"error":"rate_limit"}`}, true, ""},
		{"retries that end in a successful call are forgiven", []string{
			`{"type":"system","subtype":"api_retry","attempt":1,"error":"rate_limit"}`, `{"type":"system","subtype":"api_retry","attempt":2,"error":"rate_limit"}`,
			`{"type":"system","subtype":"api_retry","attempt":3,"error":"rate_limit"}`, start("msg_1", 1, 0, 0, 1, "")}, false, ""},
		{"a hard refusal is not forgiven by a later call", []string{
			`{"type":"assistant","error":"rate_limit","message":{"id":"m"}}`, start("msg_1", 1, 0, 0, 1, "")}, true, ""},
		{"server_error retries are not rate limits", []string{
			`{"type":"system","subtype":"api_retry","attempt":1,"error":"server_error"}`, `{"type":"system","subtype":"api_retry","attempt":2,"error":"server_error"}`,
			`{"type":"system","subtype":"api_retry","attempt":3,"error":"server_error"}`, `{"type":"system","subtype":"api_retry","attempt":4,"error":"server_error"}`}, false, ""},
		{"authentication failure", []string{`{"type":"assistant","error":"authentication_failed","message":{"id":"m"}}`}, false, "authentication_failed"},
		{"billing error", []string{`{"type":"assistant","error":"billing_error","message":{"id":"m"}}`}, false, "billing_error"},
		{"org not allowed via api_retry", []string{`{"type":"system","subtype":"api_retry","attempt":3,"error":"oauth_org_not_allowed"}`}, false, "oauth_org_not_allowed"},
		{"result with HTTP 401", []string{`{"type":"result","is_error":true,"api_error_status":401,"result":"Invalid API key"}`}, false, "authentication_failed"},
		{"ordinary error result", []string{`{"type":"result","subtype":"error_max_turns","is_error":true}`}, false, ""},
		{"invalid_request is neither", []string{`{"type":"assistant","error":"invalid_request","message":{"id":"m"}}`}, false, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			m := NewMeter()
			feedAll(t, m, c.lines...)
			o := m.Outcome()
			if o.RateLimited != c.rateLimited || o.CredentialProblem != c.credential {
				t.Fatalf("rateLimited=%v credential=%q, want %v %q", o.RateLimited, o.CredentialProblem, c.rateLimited, c.credential)
			}
			if c.rateLimited && o.Message == "" {
				t.Fatal("rate limit without an explanation")
			}
		})
	}
	m := NewMeter()
	feedAll(t, m, `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1791324000}}`)
	if got := m.Outcome().ResetAt; !got.Equal(time.Unix(1791324000, 0)) {
		t.Fatalf("reset time %v", got)
	}
}

func env(m map[string]string) func(string) (string, bool) {
	return func(k string) (string, bool) { v, ok := m[k]; return v, ok }
}

func TestCredentials(t *testing.T) {
	c := NewClaudeCode()
	ctx := context.Background()

	if _, err := c.Credentials(ctx, env(nil), "", nil); err == nil || !strings.Contains(err.Error(), EnvOAuthToken) || !strings.Contains(err.Error(), EnvAPIKey) {
		t.Fatalf("no credentials: %v", err)
	}
	if _, err := c.Credentials(ctx, env(map[string]string{EnvOAuthToken: "  "}), "", nil); err == nil {
		t.Fatal("blank token accepted")
	}

	got, err := c.Credentials(ctx, env(map[string]string{EnvOAuthToken: "sk-ant-oat01-aaaaaaaa"}), "", nil)
	if err != nil || strings.Join(got.PassEnv, ",") != EnvOAuthToken || len(got.Env) != 0 || got.Secrets[0] != "sk-ant-oat01-aaaaaaaa" {
		t.Fatalf("oauth only: %+v %v", got, err)
	}
	got, err = c.Credentials(ctx, env(map[string]string{EnvAPIKey: "sk-ant-api03-bbbbbbbb"}), "", nil)
	if err != nil || strings.Join(got.PassEnv, ",") != EnvAPIKey {
		t.Fatalf("api key only: %+v %v", got, err)
	}
	// Both set: both forwarded, the CLI decides.
	got, err = c.Credentials(ctx, env(map[string]string{EnvOAuthToken: "sk-ant-oat01-aaaaaaaa", EnvAPIKey: "sk-ant-api03-bbbbbbbb"}), "echo never-run", nil)
	if err != nil || strings.Join(got.PassEnv, ",") != EnvOAuthToken+","+EnvAPIKey || len(got.Secrets) != 2 || len(got.Env) != 0 {
		t.Fatalf("both: %+v %v", got, err)
	}
	// pass_env is an allowlist of names; unlisted variables never travel.
	e := env(map[string]string{EnvAPIKey: "sk-ant-api03-bbbbbbbb", "ANTHROPIC_BASE_URL": "https://gw.example", "AWS_SECRET_ACCESS_KEY": "should-not-pass", "UNSET_ONE": ""})
	got, _ = c.Credentials(ctx, e, "", []string{"ANTHROPIC_BASE_URL", "UNSET_ONE", "NOT_IN_ENV"})
	if strings.Join(got.PassEnv, ",") != EnvAPIKey+",ANTHROPIC_BASE_URL" {
		t.Fatalf("pass_env: %+v", got.PassEnv)
	}
	// Provider selection through pass_env counts as a credential.
	got, err = c.Credentials(ctx, env(map[string]string{"CLAUDE_CODE_USE_BEDROCK": "1", "AWS_REGION": "us-east-1"}), "", []string{"CLAUDE_CODE_USE_BEDROCK", "AWS_REGION"})
	if err != nil || len(got.PassEnv) != 2 {
		t.Fatalf("bedrock via pass_env: %+v %v", got, err)
	}
	// Token command is used only when nothing is in the environment; its value travels in Env, not in the worker's env.
	got, err = c.Credentials(ctx, env(nil), "printf 'sk-ant-oat01-fromcommand\\n'", nil)
	if err != nil || len(got.Env) != 1 || got.Env[0] != EnvOAuthToken+"=sk-ant-oat01-fromcommand" || got.Secrets[0] != "sk-ant-oat01-fromcommand" {
		t.Fatalf("token command: %+v %v", got, err)
	}
	for _, bad := range []string{"exit 3", "true", "printf 'a\\nb\\n'"} {
		if _, err := c.Credentials(ctx, env(nil), bad, nil); err == nil {
			t.Errorf("token command %q accepted", bad)
		}
	}
}

func TestClaudeCodeArgs(t *testing.T) {
	c := NewClaudeCode()
	args := strings.Join(c.Args(""), " ")
	for _, want := range []string{"claude -p", "--output-format stream-json", "--verbose", "--include-partial-messages", "--dangerously-skip-permissions",
		"--setting-sources user", "--strict-mcp-config", "--no-session-persistence"} {
		if !strings.Contains(args, want) {
			t.Errorf("args lack %q: %s", want, args)
		}
	}
	if strings.Contains(args, "--bare") {
		t.Error("--bare must not be used: bare mode never reads CLAUDE_CODE_OAUTH_TOKEN")
	}
	if strings.Contains(args, "--model") {
		t.Error("no --model unless configured")
	}
	if got := c.Args("opus"); got[len(got)-2] != "--model" || got[len(got)-1] != "opus" {
		t.Errorf("model args: %v", got)
	}
}

func TestRunStreamsPromptOnStdinAndMeters(t *testing.T) {
	c := NewClaudeCode()
	const prompt = "--help\nDo the thing.\n$(rm -rf /) `id` 'quotes' \"more\"\n"
	var gotPrompt string
	var gotArgs, gotPass, gotEnv []string
	var usages []Usage
	var events int
	var stderrLines []string
	exec := func(ctx context.Context, cmd, pass, env []string, stdin io.Reader, stdout, stderr io.Writer) (int, error) {
		gotArgs, gotPass, gotEnv = cmd, pass, env
		b, _ := io.ReadAll(stdin)
		gotPrompt = string(b)
		fmt.Fprintln(stderr, "warning: something on stderr")
		fmt.Fprintln(stdout, `{"type":"system","subtype":"init","model":"m1","claude_code_version":"9.9.9"}`)
		fmt.Fprintln(stdout, start("msg_1", 10, 0, 0, 1, ""))
		fmt.Fprintln(stdout, delta(5, ""))
		fmt.Fprintln(stdout, "not json at all")
		fmt.Fprintln(stdout, `{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"usage":{"input_tokens":10,"output_tokens":5}}`)
		return 0, nil
	}
	out, err := c.Run(context.Background(), RunSpec{
		Prompt: prompt, Model: "m1", Exec: exec,
		Creds:    Credentials{PassEnv: []string{EnvOAuthToken}, Env: []string{EnvOAuthToken + "=sk-ant-oat01-zzzzzzzz"}},
		OnEvent:  func([]byte) { events++ },
		OnUsage:  func(u Usage) { usages = append(usages, u) },
		OnStderr: func(l []byte) { stderrLines = append(stderrLines, string(l)) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if gotPrompt != prompt {
		t.Fatalf("prompt not passed verbatim on stdin: %q", gotPrompt)
	}
	for _, a := range gotArgs {
		if strings.Contains(a, "Do the thing") || strings.Contains(a, "sk-ant") {
			t.Fatalf("prompt or secret in argv: %v", gotArgs)
		}
	}
	if !strings.Contains(strings.Join(gotPass, ","), EnvOAuthToken) || !strings.Contains(strings.Join(gotPass, ","), "DISABLE_AUTOUPDATER") {
		t.Fatalf("pass env: %v", gotPass)
	}
	if !strings.Contains(strings.Join(gotEnv, " "), EnvOAuthToken+"=sk-ant-oat01-zzzzzzzz") {
		t.Fatalf("env: %v", gotEnv)
	}
	if events != 5 || len(stderrLines) != 1 || len(usages) < 2 {
		t.Fatalf("events=%d stderr=%v usages=%v", events, stderrLines, usages)
	}
	if out.TokensIn != 10 || out.TokensOut != 5 || !out.Final || out.Version != "claude-code/9.9.9" || out.Model != "m1" || out.ExitCode != 0 || out.CostUSD != 0.01 {
		t.Fatalf("outcome %+v", out)
	}
}
