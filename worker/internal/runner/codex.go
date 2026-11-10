package runner

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"slices"
	"strings"
	"sync"
)

// Credential variable names the Codex CLI reads for API-key auth.
const (
	EnvCodexAPIKey  = "CODEX_API_KEY"
	EnvOpenAIAPIKey = "OPENAI_API_KEY"
)

// CodexAPIHost is the only host Codex needs with API-key auth.
const CodexAPIHost = "api.openai.com"

// Codex runs the unmodified OpenAI Codex CLI (`codex exec`) in headless mode.
//
// EXPERIMENTAL. See CODEX_NOTES.md for what was verified and what was not.
// The important difference from Claude Code: `codex exec --json` reports token
// usage only when the turn ends, so max_tokens cannot be enforced while the
// agent is still running. The wall-clock cap (timeout_minutes) still applies,
// and a run that ends above max_tokens is recorded as having hit its cap.
type Codex struct {
	// Binary is the executable name inside the sandbox image.
	Binary string
}

// NewCodex returns the runner with defaults.
func NewCodex() *Codex { return &Codex{Binary: "codex"} }

// Name implements Runner.
func (c *Codex) Name() string { return "codex" }

// APIHosts implements Runner.
func (c *Codex) APIHosts() []string { return []string{CodexAPIHost} }

// Args are the CLI arguments used for a run. As with Claude Code the prompt is
// not among them: "-" makes `codex exec` read it from stdin.
//
//   - exec: non-interactive mode; --json: JSONL events on stdout.
//   - --dangerously-bypass-approvals-and-sandbox: nobody can answer approval
//     prompts, and Codex's own Landlock/seccomp sandbox cannot be set up inside
//     an unprivileged container. The AgentFund sandbox is the boundary.
//   - --skip-git-repo-check: the sandbox work tree has no .git.
//   - --ephemeral: no session files; the container is discarded.
//   - --ignore-user-config, --ignore-rules: no config.toml or execpolicy rules
//     (the home directory is an empty tmpfs anyway; this keeps it that way).
//   - --color never: plain text in anything that is not JSON.
//   - --disable <feature>: features that call home (chatgpt.com, github.com)
//     or drive a browser/desktop. The egress proxy would refuse them anyway;
//     disabling them keeps the agent from waiting on refused connections.
func (c *Codex) Args(model string) []string {
	args := []string{
		c.Binary, "exec",
		"--json",
		"--dangerously-bypass-approvals-and-sandbox",
		"--skip-git-repo-check",
		"--ephemeral",
		"--ignore-user-config",
		"--ignore-rules",
		"--color", "never",
	}
	for _, f := range codexDisabledFeatures {
		args = append(args, "--disable", f)
	}
	args = append(args, "-c", "analytics.enabled=false", "-c", "feedback.enabled=false")
	if model != "" {
		args = append(args, "--model", model)
	}
	return append(args, "-")
}

// Credentials implements Runner: CODEX_API_KEY and/or OPENAI_API_KEY from the
// environment, donor-listed pass_env variables, or the output of the token
// command (forwarded as CODEX_API_KEY). ChatGPT-plan sign-in (~/.codex/auth.json)
// is not supported: the worker forwards environment variables, never files.
func (c *Codex) Credentials(ctx context.Context, lookupEnv func(string) (string, bool), tokenCommand string, passEnv []string) (Credentials, error) {
	var creds Credentials
	add := func(name, value string) {
		if !slices.Contains(creds.PassEnv, name) {
			creds.PassEnv = append(creds.PassEnv, name)
		}
		if len(value) >= 8 {
			creds.Secrets = append(creds.Secrets, value)
		}
	}
	have := false
	for _, name := range []string{EnvCodexAPIKey, EnvOpenAIAPIKey} {
		if v, ok := lookupEnv(name); ok && strings.TrimSpace(v) != "" {
			add(name, v)
			have = true
		}
	}
	for _, name := range passEnv {
		if v, ok := lookupEnv(name); ok && v != "" {
			add(name, v)
		}
	}
	if !have && strings.TrimSpace(tokenCommand) != "" {
		tok, err := runTokenCommand(ctx, tokenCommand)
		if err != nil {
			return Credentials{}, err
		}
		creds.Env = append(creds.Env, EnvCodexAPIKey+"="+tok)
		add(EnvCodexAPIKey, tok)
		have = true
	}
	if !have {
		return Credentials{}, errors.New("no credentials for the coding agent: set " + EnvCodexAPIKey + " or " + EnvOpenAIAPIKey +
			" in the environment, or configure runner.token_command")
	}
	return creds, nil
}

// codexDisabledFeatures are turned off for every run (names from
// `codex features list`, 0.167.0).
var codexDisabledFeatures = []string{"plugins", "remote_plugin", "apps", "in_app_updates", "browser_use", "browser_use_external", "in_app_browser", "computer_use"}

var codexVersionRE = regexp.MustCompile(`\b(\d+\.\d+\.\d+[\w.-]*)`)

// Run implements Runner.
func (c *Codex) Run(ctx context.Context, spec RunSpec) (Outcome, error) {
	if spec.Exec == nil {
		return Outcome{}, errors.New("runner: no exec function")
	}
	// The JSONL stream does not name the CLI version; ask for it first.
	version := c.Name()
	var vout bytes.Buffer
	if code, err := spec.Exec(ctx, []string{c.Binary, "--version"}, nil, nil, nil, &vout, io.Discard); err == nil && code == 0 {
		if m := codexVersionRE.FindString(vout.String()); m != "" {
			version = c.Name() + "/" + m
		}
	}

	meter := NewCodexMeter()
	// Codex never gives up on an unreachable API by itself ("Reconnecting...
	// waiting for network" forever); stop it rather than burn timeout_minutes.
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	outR, outW := io.Pipe()
	errR, errW := io.Pipe()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(outR)
		sc.Buffer(make([]byte, 0, 64*1024), MaxLine)
		for sc.Scan() {
			line := sc.Bytes()
			if spec.OnEvent != nil {
				spec.OnEvent(line)
			}
			if meter.Feed(line) && spec.OnUsage != nil {
				spec.OnUsage(meter.Usage())
			}
			if meter.Unreachable() {
				cancel()
			}
		}
		_, _ = io.Copy(io.Discard, outR)
	}()
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(errR)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			if spec.OnStderr != nil {
				spec.OnStderr(sc.Bytes())
			}
			meter.FeedStderr(sc.Bytes())
		}
		_, _ = io.Copy(io.Discard, errR)
	}()

	env := append([]string{"NO_COLOR=1"}, spec.Creds.Env...)
	pass := append(append([]string{}, spec.Creds.PassEnv...), "NO_COLOR")
	code, err := spec.Exec(ctx, c.Args(spec.Model), pass, env, strings.NewReader(spec.Prompt), outW, errW)
	outW.Close()
	errW.Close()
	wg.Wait()

	out := meter.Outcome()
	out.ExitCode = code
	out.Version = version
	if out.Model == "" {
		out.Model = spec.Model
	}
	if err != nil {
		return out, fmt.Errorf("run %s: %w", c.Name(), err)
	}
	return out, nil
}

// CodexMeter turns a `codex exec --json` event stream into usage and an outcome.
//
// Events relied on (CODEX_NOTES.md): thread.started, turn.started,
// turn.completed {usage}, turn.failed {error.message}, error {message},
// item.* (ignored for metering). One exec is normally one turn; usage of every
// turn.completed is summed in case there are several.
type CodexMeter struct {
	usage     Usage
	turns     int
	out       Outcome
	offline   int // consecutive "waiting for network" errors
	lastError string
	// answered is set once anything shows the model API responded: an item
	// other than a CLI-side error, or the end of a turn.
	answered bool
}

// codexOfflineLimit is how many consecutive "waiting for network" errors end
// the run. Codex emits one every 20-60 s, so this is a few minutes at most.
const codexOfflineLimit = 4

// NewCodexMeter returns an empty meter.
func NewCodexMeter() *CodexMeter { return &CodexMeter{} }

type codexEvent struct {
	Type    string `json:"type"`
	Message string `json:"message"`
	Usage   *struct {
		InputTokens       int64 `json:"input_tokens"`
		CachedInputTokens int64 `json:"cached_input_tokens"`
		OutputTokens      int64 `json:"output_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
	Item *struct {
		Type string `json:"type"`
	} `json:"item"`
}

// Feed consumes one stdout line and reports whether usage changed.
func (m *CodexMeter) Feed(line []byte) bool {
	var ev codexEvent
	if len(line) == 0 || line[0] != '{' || json.Unmarshal(line, &ev) != nil {
		return false
	}
	switch ev.Type {
	case "item.started", "item.updated", "item.completed":
		if ev.Item != nil && ev.Item.Type != "error" {
			m.answered = true
		}
	case "turn.completed":
		m.answered = true
		m.turns++
		m.out.ResultSeen = true
		if u := ev.Usage; u != nil {
			// OpenAI counts cached input as a subset of input_tokens, so
			// input_tokens alone is the whole input side.
			m.usage.TokensIn += max(u.InputTokens, u.CachedInputTokens)
			m.usage.TokensOut += u.OutputTokens
			return true
		}
	case "turn.failed":
		m.out.ResultSeen = true
		m.out.IsError = true
		msg := ""
		if ev.Error != nil {
			msg = ev.Error.Message
		}
		m.out.Message = truncate(firstNonEmpty(msg, m.lastError, "turn failed"), 500)
		m.classify(msg)
	case "error":
		m.lastError = ev.Message
		if strings.Contains(ev.Message, "waiting for network") {
			m.offline++
			if m.offline == codexOfflineLimit && m.out.Message == "" {
				m.out.Message = "the model API is unreachable from the sandbox: " + truncate(ev.Message, 300)
			}
		} else {
			m.offline = 0
		}
		m.classify(ev.Message)
	}
	return false
}

// Unreachable reports that Codex has been waiting for the network for too long.
func (m *CodexMeter) Unreachable() bool { return m.offline >= codexOfflineLimit && !m.out.ResultSeen }

// FeedStderr looks at stderr for the same refusals; Codex logs some of them
// there before (or instead of) a turn.failed event.
func (m *CodexMeter) FeedStderr(line []byte) { m.classify(string(line)) }

var (
	codexCredentialRE = regexp.MustCompile(`(?i)401 Unauthorized|invalid_api_key|incorrect api key|invalid api key|missing bearer|account_deactivated|403 Forbidden`)
	codexBillingRE    = regexp.MustCompile(`(?i)insufficient_quota|exceeded your current quota|billing`)
	codexRateLimitRE  = regexp.MustCompile(`(?i)usage_limit_reached|429 Too Many Requests|rate limit|rate_limit_exceeded`)
)

func (m *CodexMeter) classify(msg string) {
	switch {
	case msg == "":
	case codexCredentialRE.MatchString(msg):
		if m.out.CredentialProblem == "" {
			m.out.CredentialProblem = "authentication_failed"
		}
	case codexBillingRE.MatchString(msg):
		// Same as Claude Code's billing_error: retrying later will not help.
		if m.out.CredentialProblem == "" {
			m.out.CredentialProblem = "billing_error"
		}
	case codexRateLimitRE.MatchString(msg):
		m.out.RateLimited = true
		if m.out.Message == "" {
			m.out.Message = truncate(msg, 500)
		}
	}
}

// Usage returns the usage so far (zero until a turn completes).
func (m *CodexMeter) Usage() Usage { return m.usage }

// Outcome returns everything learned from the stream.
func (m *CodexMeter) Outcome() Outcome {
	o := m.out
	o.Usage = m.usage
	o.Final = m.turns > 0
	if !o.ResultSeen && o.Message == "" {
		o.Message = truncate(firstNonEmpty(m.lastError, ""), 500)
	}
	if m.Unreachable() && !m.answered && o.Total() == 0 && o.CredentialProblem == "" && !o.RateLimited {
		o.NetworkProblem = truncate(m.lastError, 300) // the CLI's own words; the pipeline says "unreachable"
	}
	return o
}
