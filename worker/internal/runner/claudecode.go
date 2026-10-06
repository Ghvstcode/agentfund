package runner

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"slices"
	"strings"
	"sync"
	"time"
)

// Credential variable names Claude Code reads (docs: Authentication precedence).
const (
	EnvOAuthToken = "CLAUDE_CODE_OAUTH_TOKEN"
	EnvAPIKey     = "ANTHROPIC_API_KEY"
)

// DefaultAPIHost is the only host the agent needs with first-party credentials.
const DefaultAPIHost = "api.anthropic.com"

// ClaudeCode runs the unmodified Claude Code CLI in headless mode.
type ClaudeCode struct {
	// Binary is the executable name inside the sandbox image.
	Binary string
}

// NewClaudeCode returns the runner with defaults.
func NewClaudeCode() *ClaudeCode { return &ClaudeCode{Binary: "claude"} }

// Name implements Runner.
func (c *ClaudeCode) Name() string { return "claude-code" }

// APIHosts implements Runner.
func (c *ClaudeCode) APIHosts() []string { return []string{DefaultAPIHost} }

// Args are the CLI arguments used for a run. The prompt is NOT among them: it
// is written to stdin, so it is passed verbatim whatever it contains (leading
// dashes, any length) and never shows up in a process listing.
//
//   - -p / --print: non-interactive (headless) mode.
//   - --output-format stream-json --verbose: newline-delimited JSON events;
//     stream-json requires --verbose in print mode.
//   - --include-partial-messages: adds stream_event lines, whose
//     message_delta carries the growing output-token count needed to enforce
//     max_tokens while a long response is still being generated.
//   - --dangerously-skip-permissions: nobody can answer prompts; the sandbox
//     (not the CLI's permission system) is the boundary. The CLI refuses this
//     flag as root, which is one reason the agent runs as an unprivileged user.
//   - --setting-sources user: do not load project/local settings files from
//     the repository being worked on.
//   - --strict-mcp-config: ignore MCP server definitions found in the repo.
//   - --no-session-persistence: nothing to resume; the container is discarded.
func (c *ClaudeCode) Args(model string) []string {
	args := []string{
		c.Binary, "-p",
		"--output-format", "stream-json",
		"--verbose",
		"--include-partial-messages",
		"--dangerously-skip-permissions",
		"--setting-sources", "user",
		"--strict-mcp-config",
		"--no-session-persistence",
	}
	if model != "" {
		args = append(args, "--model", model)
	}
	return args
}

// staticEnv is forwarded into every run. None of it is secret.
var staticEnv = []string{
	"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1", // no telemetry/update traffic: only the model API is reachable anyway
	"DISABLE_AUTOUPDATER=1",
	"CI=1",
}

// Credentials implements Runner. It forwards whichever of the donor's
// credentials are set — the subscription OAuth token and/or an API key — and
// lets the unmodified CLI choose between them by its own documented
// precedence. Extra variables (e.g. ANTHROPIC_BASE_URL, Bedrock/Vertex
// settings) are forwarded only when the donor lists them in sandbox.pass_env.
// Nothing is written anywhere; values are only handed to the container CLI's
// environment for the duration of the run.
func (c *ClaudeCode) Credentials(ctx context.Context, lookupEnv func(string) (string, bool), tokenCommand string, passEnv []string) (Credentials, error) {
	var creds Credentials
	add := func(name, value string, secret bool) {
		if !slices.Contains(creds.PassEnv, name) {
			creds.PassEnv = append(creds.PassEnv, name)
		}
		if secret && len(value) >= 8 {
			creds.Secrets = append(creds.Secrets, value)
		}
	}
	have := false
	for _, name := range []string{EnvOAuthToken, EnvAPIKey} {
		if v, ok := lookupEnv(name); ok && strings.TrimSpace(v) != "" {
			add(name, v, true)
			have = true
		}
	}
	for _, name := range passEnv {
		if v, ok := lookupEnv(name); ok && v != "" {
			// Treat every donor-listed variable as potentially secret when scrubbing logs.
			add(name, v, true)
			if isCredentialVar(name) {
				have = true
			}
		}
	}
	if !have && strings.TrimSpace(tokenCommand) != "" {
		tok, err := runTokenCommand(ctx, tokenCommand)
		if err != nil {
			return Credentials{}, err
		}
		creds.Env = append(creds.Env, EnvOAuthToken+"="+tok)
		add(EnvOAuthToken, tok, true)
		have = true
	}
	if !have {
		return Credentials{}, errors.New("no credentials for the coding agent: set " + EnvOAuthToken +
			" (from `claude setup-token`) or " + EnvAPIKey + " in the environment, or configure claude_token_command; " +
			"for other providers list the needed variables in sandbox.pass_env")
	}
	return creds, nil
}

func isCredentialVar(name string) bool {
	switch name {
	case "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK":
		return true
	}
	return false
}

func runTokenCommand(ctx context.Context, command string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	var out bytes.Buffer
	cmd.Stdout = &out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("claude_token_command failed: %w", err)
	}
	tok := strings.TrimSpace(out.String())
	if tok == "" || strings.ContainsAny(tok, "\r\n") {
		return "", errors.New("claude_token_command must print exactly one non-empty line")
	}
	return tok, nil
}

// MaxLine bounds a single stream line (tool results can be large).
const MaxLine = 32 << 20

// Run implements Runner.
func (c *ClaudeCode) Run(ctx context.Context, spec RunSpec) (Outcome, error) {
	if spec.Exec == nil {
		return Outcome{}, errors.New("runner: no exec function")
	}
	meter := NewMeter()
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
		}
		_, _ = io.Copy(io.Discard, outR) // keep draining if a line was too long
	}()
	go func() {
		defer wg.Done()
		sc := bufio.NewScanner(errR)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		for sc.Scan() {
			if spec.OnStderr != nil {
				spec.OnStderr(sc.Bytes())
			}
		}
		_, _ = io.Copy(io.Discard, errR)
	}()

	env := append(append([]string{}, staticEnv...), spec.Creds.Env...)
	pass := append([]string{}, spec.Creds.PassEnv...)
	for _, kv := range staticEnv {
		name, _, _ := strings.Cut(kv, "=")
		pass = append(pass, name)
	}
	code, err := spec.Exec(ctx, c.Args(spec.Model), pass, env, strings.NewReader(spec.Prompt), outW, errW)
	outW.Close()
	errW.Close()
	wg.Wait()

	out := meter.Outcome()
	out.ExitCode = code
	if out.Version == "" {
		out.Version = c.Name()
	}
	if err != nil {
		return out, fmt.Errorf("run %s: %w", c.Name(), err)
	}
	return out, nil
}
